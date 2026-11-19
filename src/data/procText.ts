// A stored procedure's definition text, read without any database: its name, its parameters and the columns of the
// rows it returns (the first SELECT that sends rows back), plus made-up rows of that shape — so a report can be
// designed from the procedure's text alone. The application that shows the report sends the real rows later.
import type { FieldDef, FieldType, ParamType, Row } from '../model/types';

export interface ProcParam {
  name: string;
  /** as written, e.g. INT, NVARCHAR(64), DECIMAL(19,4) */
  dbType: string;
  type: ParamType;
  /** the procedure's own default when it is a plain value (= 'DAY', = 25); '' for NULL or none */
  defaultValue: string;
  output: boolean;
}
export interface ProcText {
  schema?: string;
  name: string;
  params: ProcParam[];
  /** columns of the first result set ([] when none could be read) */
  fields: FieldDef[];
  /** how many SELECTs send rows back (the first one is used) */
  resultSets: number;
  /** the result set has SELECT * — its columns cannot be known from the text */
  star: boolean;
  /** procedures it runs (EXEC x): when it has no SELECT of its own, the rows come from one of these */
  calls: string[];
}

/** The text holds a CREATE / ALTER PROCEDURE statement. */
export function looksLikeProcedureText(text: string): boolean {
  return /\b(CREATE|ALTER)\s+(OR\s+ALTER\s+)?PROC(EDURE)?\b/i.test(text ?? '');
}

/* ------------------------------------------------------------------ tokens */

type Kind = 'id' | 'qid' | 'var' | 'str' | 'num' | 'op' | '(' | ')' | ',' | ';' | '.';
/** u: the upper-case word of a plain identifier (to compare keywords); '' for everything else */
interface Tok {
  k: Kind;
  v: string;
  u: string;
}

const RE_VAR = /@@?[\w$#]*/y;
const RE_NUM = /0x[0-9a-f]*|\d+(\.\d*)?(e[+-]?\d+)?/iy;
const RE_ID = /[A-Za-z_#À-￿][\w@$#À-￿]*/y;
const OPS2 = new Set(['>=', '<=', '<>', '!=', '!<', '!>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::']);

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const push = (k: Kind, v: string) => out.push({ k, v, u: k === 'id' ? v.toUpperCase() : '' });
  const sticky = (re: RegExp, at: number) => {
    re.lastIndex = at;
    return re.exec(s)?.[0] ?? '';
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c <= ' ' || c === ' ' || c === '﻿') {
      i++;
    } else if (s.startsWith('--', i)) {
      const j = s.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
    } else if (s.startsWith('/*', i)) {
      // block comments nest in T-SQL
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (s.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (s.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'" || ((c === 'N' || c === 'n') && s[i + 1] === "'")) {
      i += c === "'" ? 1 : 2;
      let v = '';
      while (i < n) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += s[i++];
      }
      push('str', v);
    } else if (c === '[') {
      let v = '';
      i++;
      while (i < n) {
        if (s[i] === ']') {
          if (s[i + 1] === ']') {
            v += ']';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += s[i++];
      }
      push('qid', v);
    } else if (c === '"' || c === '`') {
      const j = s.indexOf(c, i + 1);
      const end = j < 0 ? n : j;
      push('qid', s.slice(i + 1, end));
      i = end + 1;
    } else if (c === '@') {
      const v = sticky(RE_VAR, i);
      push('var', v);
      i += v.length;
    } else if (c >= '0' && c <= '9') {
      const v = sticky(RE_NUM, i);
      push('num', v);
      i += v.length;
    } else if (c === '(' || c === ')' || c === ',' || c === ';' || c === '.') {
      push(c, c);
      i++;
    } else {
      const id = sticky(RE_ID, i);
      if (id) {
        push('id', id);
        i += id.length;
      } else {
        const two = s.slice(i, i + 2);
        const op = OPS2.has(two) ? two : c;
        push('op', op);
        i += op.length;
      }
    }
  }
  return out;
}

/** index of the ')' that closes the '(' at `open` (or the last token) */
function closeOf(t: Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < t.length; k++) {
    if (t[k].k === '(') depth++;
    else if (t[k].k === ')' && --depth === 0) return k;
  }
  return t.length - 1;
}
/** index of the '(' that the ')' at `close` closes */
function openOf(t: Tok[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    if (t[k].k === ')') depth++;
    else if (t[k].k === '(' && --depth === 0) return k;
  }
  return 0;
}
/** split on commas outside parentheses */
function splitTop(t: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const x of t) {
    if (x.k === '(') depth++;
    else if (x.k === ')') depth--;
    if (x.k === ',' && depth === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(x);
  }
  if (cur.length) out.push(cur);
  return out;
}
/** a data type written from t[k]: [schema.]name[(size)] -> "NVARCHAR(64)", and the index after it */
function readType(t: Tok[], k: number): [string, number] {
  let s = '';
  while (t[k] && (t[k].k === 'id' || t[k].k === 'qid')) {
    s += t[k].v;
    k++;
    if (t[k]?.k === '.' && (t[k + 1]?.k === 'id' || t[k + 1]?.k === 'qid')) {
      s += '.';
      k++;
    } else break;
  }
  if (s && t[k]?.k === '(') {
    const c = closeOf(t, k);
    s += '(' + t.slice(k + 1, c).map((x) => x.v).join('') + ')';
    k = c + 1;
  }
  return [s.toUpperCase(), k];
}

/* ------------------------------------------------------------------ types */

/** SQL data type -> report type: INT, DECIMAL(19,4) -> number; DATE, DATETIME2 -> date; BIT -> boolean */
export function sqlTypeToField(dbType: string): FieldType {
  const b = dbType.toUpperCase().replace(/\(.*$/, '').replace(/^.*\./, '').trim();
  if (/^(TINYINT|SMALLINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|MONEY|SMALLMONEY|FLOAT|REAL|DOUBLE|NUMBER)$/.test(b)) return 'number';
  if (/^(DATE|DATETIME|DATETIME2|SMALLDATETIME|DATETIMEOFFSET|TIMESTAMPTZ)$/.test(b)) return 'date';
  if (/^(BIT|BOOL|BOOLEAN)$/.test(b)) return 'boolean';
  return 'string';
}

/** "SALE_DATE" -> [SALE, DATE]; "orderDate" -> [ORDER, DATE] */
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

const NUM_WORDS = new Set([
  'ID', 'QTY', 'QUANTITY', 'AMT', 'AMOUNT', 'TOTAL', 'SUBTOTAL', 'PRICE', 'COST', 'COGS', 'RATE', 'PCT', 'PERCENT', 'BALANCE',
  'DISCOUNT', 'TAX', 'FEE', 'COUNT', 'CNT', 'SUM', 'AVG', 'PROFIT', 'REVENUE', 'GROSS', 'NET', 'MARGIN', 'POINTS', 'SALARY',
  'ORDERS', 'ITEMS', 'LINES', 'DAYS', 'HOURS', 'SCORE', 'WEIGHT', 'AGE', 'PAID', 'DUE', 'CASH', 'VALUE', 'STOCK', 'ONHAND',
  'LEVEL', 'SOLD', 'AVAILABLE',
]);
const STR_WORDS = new Set([
  'NAME', 'CODE', 'NO', 'NUM', 'NUMBER', 'PHONE', 'TEL', 'EMAIL', 'NOTE', 'DES', 'DESC', 'DESCRIPTION', 'TEXT', 'LABEL', 'STS',
  'STATUS', 'TYPE', 'CCY', 'CURRENCY', 'ADDRESS', 'KEY', 'TITLE', 'REMARK', 'REASON', 'MODE', 'URL', 'IMG', 'IMAGE', 'PHOTO',
  'SKU', 'REF', 'SOURCE', 'GENDER', 'SEX', 'LOCAL', 'ENG', 'EN', 'KH',
]);

/** a column's type from its name alone (the text does not say); null when the name says nothing */
function nameGuess(name: string): FieldType | null {
  const w = words(name);
  const last = w[w.length - 1] ?? '';
  if (/^(IS|HAS|CAN|ALLOW|ENABLE|ENABLED)$/.test(w[0] ?? '') || last === 'FLAG') return 'boolean';
  if (w.includes('TIME') && !w.includes('DATETIME')) return 'string';
  if (w.some((x) => x === 'DATE' || x === 'DATETIME' || x === 'DT' || x === 'DOB')) return 'date';
  if (/^(CREATED|UPDATED|MODIFIED|DELETED)$/.test(w[0] ?? '') && (last === 'AT' || last === 'ON')) return 'date';
  if (last === 'ID') return 'number';
  if (w.length === 1 && /^(NO|NUM|RN|ROWNUM|SEQ)$/.test(last)) return 'number';
  if (STR_WORDS.has(last)) return 'string';
  if (w.some((x) => NUM_WORDS.has(x)) && !w.some((x) => STR_WORDS.has(x))) return 'number';
  return null;
}
export const typeFromName = (name: string): FieldType => nameGuess(name) ?? 'string';

/** types the text gives names: "@TODAY" (DECLARE / parameters) and column aliases of every SELECT (CTEs, sub-queries) */
type Known = Map<string, FieldType>;

const NUM_FN = new Set([
  'COUNT', 'COUNT_BIG', 'SUM', 'AVG', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'ABS', 'ROUND', 'CEILING', 'FLOOR', 'POWER',
  'SQRT', 'SQUARE', 'EXP', 'LOG', 'LOG10', 'SIGN', 'LEN', 'DATALENGTH', 'DATEDIFF', 'DATEDIFF_BIG', 'DATEPART', 'YEAR', 'MONTH',
  'DAY', 'CHARINDEX', 'PATINDEX', 'ISNUMERIC', 'STDEV', 'VAR', 'PI', 'RAND',
]);
const DATE_FN = new Set([
  'GETDATE', 'GETUTCDATE', 'SYSDATETIME', 'SYSUTCDATETIME', 'SYSDATETIMEOFFSET', 'DATEADD', 'EOMONTH', 'DATEFROMPARTS',
  'DATETIMEFROMPARTS', 'DATETIME2FROMPARTS', 'SMALLDATETIMEFROMPARTS', 'TODATETIMEOFFSET', 'SWITCHOFFSET', 'DATETRUNC', 'CURRENT_TIMESTAMP',
]);
const STR_FN = new Set([
  'CONCAT', 'CONCAT_WS', 'FORMAT', 'STRING_AGG', 'LEFT', 'RIGHT', 'SUBSTRING', 'UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'TRIM',
  'REPLACE', 'STUFF', 'REPLICATE', 'DATENAME', 'STR', 'CHAR', 'NCHAR', 'QUOTENAME', 'TRANSLATE', 'REVERSE', 'SPACE', 'NEWID',
  'JSON_VALUE', 'JSON_QUERY', 'STRING_ESCAPE',
]);

/** The type an expression gives, when the text shows it (CAST, COUNT, 'text', 1.5, @x …); null when only a name can tell. */
function exprType(ex: Tok[], known: Known): FieldType | null {
  if (!ex.length) return null;
  const f = ex[0];
  // ( … ) around the whole expression: a sub-query or a bracketed expression
  if (f.k === '(' && closeOf(ex, 0) === ex.length - 1) {
    const inner = ex.slice(1, -1);
    if (inner[0]?.u === 'SELECT') {
      // … FOR JSON / FOR XML hands back text
      if (inner.some((x, k) => x.u === 'FOR' && (inner[k + 1]?.u === 'JSON' || inner[k + 1]?.u === 'XML'))) return 'string';
      const first = readSelect(inner, 1, true)?.items[0];
      return first ? exprType(first.expr, known) ?? colType(first.expr, known) : null;
    }
    return exprType(inner, known);
  }
  if (ex.length === 1) {
    if (f.k === 'num') return 'number';
    if (f.k === 'str') return 'string';
    if (f.k === 'var') return known.get(f.v.toUpperCase()) ?? nameGuess(f.v.slice(1));
    return null;
  }
  if (f.k === 'op' && f.v === '-' && ex.length === 2 && ex[1].k === 'num') return 'number';

  // fn( … ) [OVER ( … )] as the whole expression
  if (f.k === 'id' && ex[1]?.k === '(') {
    const c = closeOf(ex, 1);
    const whole = c === ex.length - 1 || (ex[c + 1]?.u === 'OVER' && ex[c + 2]?.k === '(' && closeOf(ex, c + 2) === ex.length - 1);
    if (whole) {
      const args = ex.slice(2, c);
      if (f.u === 'CAST' || f.u === 'TRY_CAST') {
        let as = -1;
        let depth = 0;
        args.forEach((x, k) => {
          if (x.k === '(') depth++;
          else if (x.k === ')') depth--;
          else if (depth === 0 && x.u === 'AS') as = k;
        });
        if (as >= 0) return sqlTypeToField(readType(args, as + 1)[0]);
      }
      if (f.u === 'CONVERT' || f.u === 'TRY_CONVERT') return sqlTypeToField(readType(args, 0)[0]);
      if (NUM_FN.has(f.u)) return 'number';
      if (DATE_FN.has(f.u)) return 'date';
      if (STR_FN.has(f.u)) return 'string';
      if (f.u === 'IIF') {
        const a = splitTop(args);
        return exprType(a[1] ?? [], known) ?? colType(a[1] ?? [], known) ?? exprType(a[2] ?? [], known) ?? colType(a[2] ?? [], known);
      }
      if (f.u === 'ISNULL' || f.u === 'COALESCE' || f.u === 'NULLIF' || f.u === 'MIN' || f.u === 'MAX' || f.u === 'CHOOSE') {
        for (const a of splitTop(args).slice(f.u === 'CHOOSE' ? 1 : 0)) {
          const t = exprType(a, known) ?? colType(a, known);
          if (t) return t;
        }
        return null;
      }
    }
  }
  // CASE … THEN x … ELSE y END: the type of its results
  if (f.u === 'CASE') {
    let depth = 0;
    let cases = 0;
    let seg: Tok[] | null = null;
    for (const x of ex) {
      if (x.k === '(') depth++;
      else if (x.k === ')') depth--;
      if (depth === 0 && x.k === 'id') {
        if (x.u === 'CASE') cases++;
        if (cases === 1 && (x.u === 'WHEN' || x.u === 'ELSE' || x.u === 'END') && seg) {
          const t = exprType(seg, known) ?? colType(seg, known);
          if (t) return t;
          seg = null;
        }
        if (x.u === 'END') cases--;
        if (cases === 1 && (x.u === 'THEN' || x.u === 'ELSE')) {
          seg = [];
          continue;
        }
      }
      seg?.push(x);
    }
    return null;
  }
  // value AT TIME ZONE …
  if (ex.some((x, k) => x.u === 'AT' && ex[k + 1]?.u === 'TIME' && ex[k + 2]?.u === 'ZONE')) return 'date';
  // arithmetic: * / % give numbers; + with text joins text
  let depth = 0;
  const parts: Tok[][] = [[]];
  let mul = false;
  for (const x of ex) {
    if (x.k === '(') depth++;
    else if (x.k === ')') depth--;
    if (depth === 0 && x.k === 'op' && /^[-+*/%]$/.test(x.v)) {
      if (x.v !== '+' && x.v !== '-') mul = true;
      parts.push([]);
    } else parts[parts.length - 1].push(x);
  }
  if (parts.length > 1) {
    const types = parts.filter((p) => p.length).map((p) => exprType(p, known) ?? colType(p, known));
    if (types.includes('string')) return 'string';
    if (mul || types.includes('number')) return 'number';
    if (types.includes('date')) return 'date';
  }
  return null;
}
/** t.COL / [Some Name] / s.t.COL: identifiers joined by dots */
const isColRef = (ex: Tok[]) => ex.length % 2 === 1 && ex.every((x, k) => (k % 2 ? x.k === '.' : x.k === 'id' || x.k === 'qid'));
/** a bare column (o.TOTAL_AMT): the type of an alias of that name made earlier in the text, else what its name suggests */
function colType(ex: Tok[], known: Known): FieldType | null {
  if (!isColRef(ex)) return null;
  const name = ex[ex.length - 1].v;
  return known.get(name.toUpperCase()) ?? nameGuess(name);
}

/* ------------------------------------------------------------------ SELECT lists */

const NOT_ALIAS = new Set(['END', 'NULL']);
/** words that end a SELECT list (outside parentheses and CASE) */
const LIST_END = new Set([
  'FROM', 'INTO', 'WHERE', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'FOR', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'MERGE', 'SET', 'DECLARE', 'IF', 'WHILE', 'BEGIN', 'RETURN', 'EXEC', 'EXECUTE', 'PRINT', 'RAISERROR', 'THROW', 'COMMIT',
  'ROLLBACK', 'GO', 'ELSE', 'WITH', 'TRUNCATE', 'CLOSE', 'OPEN', 'FETCH', 'DEALLOCATE', 'WAITFOR', 'BREAK', 'CONTINUE',
]);

interface Item {
  name?: string;
  expr: Tok[];
  /** a plain column reference (t.COL) */
  colRef: boolean;
  star?: boolean;
}

function readItem(it: Tok[]): Item {
  // "x COLLATE Khmer_100_CI_AS": the collation is not a name
  if (it.length >= 3 && it[it.length - 2].u === 'COLLATE') it = it.slice(0, -2);
  const n = it.length;
  const last = it[n - 1];
  const prev = it[n - 2];
  if (last?.k === 'op' && last.v === '*' && (n === 1 || prev?.k === '.')) return { expr: it, colRef: false, star: true };
  // NAME = expression
  if (n >= 3 && (it[0].k === 'id' || it[0].k === 'qid' || it[0].k === 'str') && it[1].k === 'op' && it[1].v === '=')
    return { name: it[0].v, expr: it.slice(2), colRef: false };
  // expression AS NAME
  if (n >= 3 && prev.u === 'AS' && (last.k === 'id' || last.k === 'qid' || last.k === 'str')) return { name: last.v, expr: it.slice(0, n - 2), colRef: false };
  // t.COL
  if (isColRef(it)) return { name: last.v, expr: it, colRef: true };
  // expression NAME
  if (n >= 2 && (last.k === 'id' || last.k === 'qid') && !NOT_ALIAS.has(last.u) && prev.k !== '.' && prev.k !== 'op' && prev.k !== '(' && prev.k !== ',' && prev.u !== 'COLLATE')
    return { name: last.v, expr: it.slice(0, n - 1), colRef: false };
  return { expr: it, colRef: false };
}

/**
 * The SELECT list starting at t[k] (just after SELECT). null for SELECT @x = … (assigns) and SELECT … INTO (fills a
 * table), unless `any` (reading the names a SELECT makes, wherever it is).
 */
function readSelect(t: Tok[], k: number, any = false): { items: Item[] } | null {
  if (t[k]?.u === 'ALL' || t[k]?.u === 'DISTINCT') k++;
  if (t[k]?.u === 'TOP') {
    k++;
    k = t[k]?.k === '(' ? closeOf(t, k) + 1 : k + 1;
    if (t[k]?.u === 'PERCENT') k++;
    if (t[k]?.u === 'WITH' && t[k + 1]?.u === 'TIES') k += 2;
  }
  const raw: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  let cases = 0;
  let end: Tok | undefined;
  for (; k < t.length; k++) {
    const x = t[k];
    if (x.k === '(') depth++;
    else if (x.k === ')') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0) {
      if (x.k === ';') break;
      if (x.k === ',' && cases === 0) {
        raw.push(cur);
        cur = [];
        continue;
      }
      if (x.k === 'id') {
        if (x.u === 'CASE') cases++;
        else if (x.u === 'END') {
          if (cases === 0) break;
          cases--;
        } else if (cases === 0 && (LIST_END.has(x.u) || ((x.u === 'GROUP' || x.u === 'ORDER') && t[k + 1]?.u === 'BY'))) {
          end = x;
          break;
        }
      }
    }
    cur.push(x);
  }
  if (cur.length) raw.push(cur);
  const items = raw.filter((r) => r.length).map(readItem);
  if (any) return { items };
  if (end?.u === 'INTO') return null;
  if (raw.some((r) => r[0]?.k === 'var' && r[1]?.k === 'op' && /^[-+*/%&|^]?=$/.test(r[1].v))) return null;
  return { items };
}

/** SELECT at t[j] (outside parentheses) sends rows back: not UNION's second part, not INSERT … SELECT, not a cursor's */
function sendsRows(t: Tok[], j: number): boolean {
  const prev = t[j - 1];
  if (prev && /^(UNION|ALL|EXCEPT|INTERSECT|FOR)$/.test(prev.u)) return false;
  // INSERT [INTO] target [(columns)] SELECT …
  let k = j - 1;
  if (t[k]?.k === ')') k = openOf(t, k) - 1;
  for (let n = 0; k >= 0 && n < 7; n++, k--) {
    const x = t[k];
    if (!(x.k === 'qid' || x.k === 'var' || x.k === '.' || (x.k === 'id' && !LIST_END.has(x.u) && x.u !== 'INTO' && x.u !== 'AS' && x.u !== 'END' && x.u !== 'THEN')))
      break;
  }
  if (t[k]?.u === 'INTO') k--;
  return t[k]?.u !== 'INSERT';
}

/* ------------------------------------------------------------------ the procedure */

/** Read a CREATE / ALTER PROCEDURE text. null when it has no procedure header. */
export function parseProcedureText(text: string): ProcText | null {
  const t = tokenize(text ?? '');
  // CREATE [OR ALTER] PROC[EDURE] / ALTER PROC[EDURE]
  let k = -1;
  for (let i = 0; i < t.length && k < 0; i++) {
    if (t[i].u !== 'CREATE' && t[i].u !== 'ALTER') continue;
    let j = i + 1;
    if (t[j]?.u === 'OR' && t[j + 1]?.u === 'ALTER') j += 2;
    if (t[j]?.u === 'PROC' || t[j]?.u === 'PROCEDURE') k = j + 1;
  }
  if (k < 0) return null;

  const parts: string[] = [];
  while (t[k]?.k === 'id' || t[k]?.k === 'qid') {
    parts.push(t[k].v);
    k++;
    if (t[k]?.k === '.') k++;
    else break;
  }
  if (!parts.length) return null;
  if (t[k]?.k === ';' && t[k + 1]?.k === 'num') k += 2; // numbered procedure: name;1

  // the parameters: ( … ) or up to WITH / FOR / AS
  let pt: Tok[];
  if (t[k]?.k === '(') {
    const c = closeOf(t, k);
    pt = t.slice(k + 1, c);
    k = c + 1;
  } else {
    const s = k;
    let depth = 0;
    for (; k < t.length; k++) {
      if (t[k].k === '(') depth++;
      else if (t[k].k === ')') depth--;
      else if (depth === 0 && (t[k].u === 'AS' || t[k].u === 'WITH' || t[k].u === 'FOR')) break;
    }
    pt = t.slice(s, k);
  }
  const params: ProcParam[] = [];
  for (const p of splitTop(pt)) {
    if (p[0]?.k !== 'var') continue;
    const [dbType, after] = readType(p, p[1]?.u === 'AS' ? 2 : 1);
    if (p.slice(after).some((x) => x.u === 'READONLY')) continue; // table-valued: nothing a report can fill
    const eq = p.findIndex((x, i) => i >= after && x.k === 'op' && x.v === '=');
    const dv = eq < 0 ? [] : p.slice(eq + 1).filter((x) => !/^(OUT|OUTPUT|READONLY)$/.test(x.u));
    let defaultValue = '';
    if (dv.length === 1 && (dv[0].k === 'str' || dv[0].k === 'num')) defaultValue = dv[0].v;
    else if (dv.length === 2 && dv[0].v === '-' && dv[1].k === 'num') defaultValue = '-' + dv[1].v;
    params.push({
      name: p[0].v.replace(/^@/, ''),
      dbType,
      type: sqlTypeToField(dbType),
      defaultValue,
      output: p.slice(after).some((x) => x.u === 'OUT' || x.u === 'OUTPUT'),
    });
  }

  // options (WITH ENCRYPTION, EXECUTE AS OWNER …), FOR REPLICATION, then AS and the body
  if (t[k]?.u === 'WITH') {
    k++;
    while (k < t.length) {
      if (t[k].u === 'EXECUTE' || t[k].u === 'EXEC') k += 3;
      else k++;
      if (t[k]?.k === ',') k++;
      else break;
    }
  }
  if (t[k]?.u === 'FOR' && t[k + 1]?.u === 'REPLICATION') k += 2;
  if (t[k]?.u === 'AS') k++;
  let body = t.slice(k);
  const go = body.findIndex((x) => x.u === 'GO');
  if (go >= 0) body = body.slice(0, go);

  // what the text says about names: parameters and DECLAREd variables, then every alias of every SELECT
  const known: Known = new Map();
  const learn = (name: string, type: FieldType | null) => {
    if (type && !known.has(name.toUpperCase())) known.set(name.toUpperCase(), type);
  };
  params.forEach((p) => learn('@' + p.name, p.type));
  body.forEach((x, j) => {
    if (x.u !== 'DECLARE') return;
    // DECLARE @a INT = 1, @b DATE … (a TABLE / CURSOR declares no value)
    for (let k = j + 1; body[k]?.k === 'var'; ) {
      const v = body[k].v;
      const [type, after] = readType(body, body[k + 1]?.u === 'AS' ? k + 2 : k + 1);
      if (type && !/^(TABLE|CURSOR)/.test(type)) learn(v, sqlTypeToField(type));
      let depth = 0;
      for (k = after; k < body.length; k++) {
        if (body[k].k === '(') depth++;
        else if (body[k].k === ')') depth--;
        else if (depth === 0 && (body[k].k === ',' || body[k].k === ';' || (body[k].k === 'id' && LIST_END.has(body[k].u)))) break;
      }
      if (body[k]?.k !== ',') break;
      k++;
    }
  });
  // twice: an alias may be typed by another alias made later in the text (a CTE read further down)
  for (let pass = 0; pass < 2; pass++)
    body.forEach((x, j) => {
      if (x.u !== 'SELECT') return;
      for (const it of readSelect(body, j + 1, true)?.items ?? [])
        if (it.name && !it.colRef) learn(it.name, exprType(it.expr, known) ?? colType(it.expr, known));
    });

  // the SELECTs that send rows back (outside parentheses), and the procedures it runs
  const sets: Item[][] = [];
  const calls: string[] = [];
  let depth = 0;
  for (let j = 0; j < body.length; j++) {
    const x = body[j];
    if (x.k === '(') depth++;
    else if (x.k === ')') depth--;
    else if (depth === 0 && x.u === 'SELECT' && sendsRows(body, j)) {
      const sel = readSelect(body, j + 1);
      if (sel?.items.length) sets.push(sel.items);
    } else if ((x.u === 'EXEC' || x.u === 'EXECUTE') && (body[j + 1]?.k === 'id' || body[j + 1]?.k === 'qid') && body[j + 1].u !== 'AS') {
      // EXEC [@ret =] schema.proc …
      let k = j + 1;
      let name = body[k].v;
      while (body[k + 1]?.k === '.' && (body[k + 2]?.k === 'id' || body[k + 2]?.k === 'qid')) {
        name += '.' + body[k + 2].v;
        k += 2;
      }
      if (!/^sp_executesql$/i.test(name) && !calls.includes(name)) calls.push(name);
    }
  }

  const first = sets[0] ?? [];
  const fields: FieldDef[] = [];
  first.forEach((it, i) => {
    if (it.star) return;
    const name = it.name ?? `Column${i + 1}`;
    if (fields.some((f) => f.name.toLowerCase() === name.toLowerCase())) return;
    const type = exprType(it.expr, known) ?? colType(it.expr, known) ?? (it.name ? nameGuess(name) : null) ?? 'string';
    fields.push({ name, type });
  });
  return {
    schema: parts.length > 1 ? parts[parts.length - 2] : undefined,
    name: parts[parts.length - 1],
    params,
    fields,
    resultSets: sets.length,
    star: first.some((it) => it.star),
    calls,
  };
}

/* ------------------------------------------------------------------ made-up rows */

const PEOPLE = ['Sok Dara', 'Chan Sophea', 'Ly Menghong', 'Heng Sreyneang', 'Kim Vannak', 'Sun Chantrea', 'Pov Rotana', 'Mao Sokly'];
const PEOPLE_KH = ['សុខ ដារ៉ា', 'ចាន់ សុភា', 'លី ម៉េងហុង', 'ហេង ស្រីនាង', 'គឹម វណ្ណៈ', 'ស៊ុន ចន្ទ្រា', 'ពៅ រតនា', 'ម៉ៅ សុខលី'];
const BRANCHES = ['Phnom Penh Branch', 'Siem Reap Branch', 'Battambang Branch'];
const BRANCHES_KH = ['សាខាភ្នំពេញ', 'សាខាសៀមរាប', 'សាខាបាត់ដំបង'];
const PRODUCTS = ['Iced Coffee', 'Green Tea', 'Drinking Water', 'Fried Rice', 'Chocolate Cake', 'Potato Chips'];
const PRODUCTS_KH = ['កាហ្វេទឹកកក', 'តែបៃតង', 'ទឹកសុទ្ធ', 'បាយឆា', 'នំខេកសូកូឡា', 'ដំឡូងបារាំងចៀន'];
const CATEGORIES = ['Drinks', 'Food', 'Snacks'];
const CATEGORIES_KH = ['ភេសជ្ជៈ', 'អាហារ', 'នំ'];
const PAYMENTS = ['Cash', 'KHQR', 'Card'];
const PAYMENTS_KH = ['សាច់ប្រាក់', 'KHQR', 'កាត'];
const USERS = ['admin', 'cashier1', 'cashier2'];

/** the same "random" numbers every time for the same field */
function seeded(name: string) {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) | 0;
    return (h >>> 0) / 4294967296;
  };
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fakeValue(f: FieldDef, i: number, rnd: () => number, base: Date): unknown {
  const w = words(f.name);
  const has = (...xs: string[]) => xs.some((x) => w.includes(x));
  const last = w[w.length - 1] ?? '';
  const pick = <T>(en: T[], kh?: T[]) => (kh && has('LOCAL', 'KH', 'KM', 'KHMER') ? kh : en)[i % en.length];
  if (f.type === 'date') {
    const day = has('TO', 'END', 'UNTIL') ? 28 : has('FROM', 'START', 'BEGIN') ? 1 : 1 + ((i * 2) % 28);
    return isoDate(new Date(base.getFullYear(), base.getMonth(), day));
  }
  if (f.type === 'boolean') return i % 3 !== 0;
  if (f.type === 'number') {
    if (last === 'ID') return (i % 5) + 1;
    if (w.length <= 2 && has('NO', 'NUM', 'RN', 'ROW', 'ROWNUM', 'SEQ', 'LINE')) return i + 1;
    if (has('RATE') && has('EXCH', 'EXCHANGE')) return 1;
    if (has('PCT', 'PERCENT', 'MARGIN')) return round2(10 + rnd() * 60);
    if (has('QTY', 'QUANTITY', 'COUNT', 'CNT', 'ITEMS', 'ORDERS', 'LINES', 'DAYS', 'HOURS', 'POINTS', 'AGE')) return 1 + Math.floor(rnd() * 20);
    return round2(1 + rnd() * 250);
  }
  if (has('TIME')) return `${pad(7 + ((i * 5) % 14))}:${pad((i * 17) % 60)}`;
  if (has('PHONE', 'TEL', 'MOBILE')) return `012 345 ${pad(100 + i, 3)}`;
  if (has('EMAIL', 'MAIL')) return `user${i + 1}@example.com`;
  if (has('CCY', 'CURRENCY')) return i % 4 === 3 ? 'KHR' : 'USD';
  if (has('STS', 'STATUS', 'STATE')) return has('PAYMENT', 'PAY') ? ['PAID', 'PAID', 'PARTIAL'][i % 3] : ['COMPLETED', 'COMPLETED', 'PENDING'][i % 3];
  if (has('NAME', 'LABEL', 'TITLE')) {
    if (has('BR', 'BRANCH', 'SHOP', 'STORE')) return pick(BRANCHES, BRANCHES_KH);
    if (has('PRODUCT', 'PRO', 'ITEM', 'VAR', 'VARIANT', 'GOODS')) return pick(PRODUCTS, PRODUCTS_KH);
    if (has('CAT', 'CATEGORY', 'GROUP', 'BRAND', 'BRD')) return pick(CATEGORIES, CATEGORIES_KH);
    if (has('PM', 'PAYMENT', 'METHOD')) return pick(PAYMENTS, PAYMENTS_KH);
    if (has('USER', 'CASHIER')) return pick(USERS);
    return pick(PEOPLE, PEOPLE_KH);
  }
  if (has('CUSTOMER', 'CLIENT', 'SUPPLIER', 'EMPLOYEE', 'STAFF', 'PERSON')) return pick(PEOPLE, PEOPLE_KH);
  if (has('CASHIER', 'USER')) return pick(USERS);
  if (has('BRANCH')) return pick(BRANCHES, BRANCHES_KH);
  if (has('PRODUCT', 'ITEM')) return pick(PRODUCTS, PRODUCTS_KH);
  if (has('NOTE', 'REMARK', 'REASON', 'DES', 'DESC', 'DESCRIPTION', 'COMMENT')) return has('LOCAL', 'KH') ? 'កំណត់សម្គាល់' : 'Sample note';
  if (has('SOURCE', 'CHANNEL')) return ['POS', 'POS', 'WEB'][i % 3];
  if (has('KEY', 'GROUP')) return `Group ${(i % 4) + 1}`;
  if (has('NO', 'NUMBER', 'CODE', 'REF', 'DOC', 'SKU', 'INVOICE')) return `${(w.find((x) => x !== 'NO' && x !== 'CODE') ?? 'NO').slice(0, 3)}-${pad(i + 1, 5)}`;
  if (has('TYPE', 'MODE', 'KIND')) return ['A', 'B', 'C'][i % 3];
  return `${f.name} ${i + 1}`;
}

/** Made-up rows for the fields (the same each time), dated in the current month. */
export function fakeRows(fields: FieldDef[], count = 12, today = new Date()): Row[] {
  const rnd = new Map(fields.map((f) => [f.name, seeded(f.name)]));
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const r: Row = {};
    for (const f of fields) r[f.name] = fakeValue(f, i, rnd.get(f.name)!, today);
    rows.push(r);
  }
  return rows;
}

/** rows as JSON text, one row per line */
export function rowsToJsonText(rows: Row[]): string {
  return rows.length ? '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]' : '[]';
}
