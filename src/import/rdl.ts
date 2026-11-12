// RDL (SQL Server Reporting Services / Report Builder) -> ReportTool report definition (best effort).
//   - page size, margins, parameters, data sets (database queries / procedures, embedded XML data), calculated fields
//   - body: the first data table/list becomes the main Detail (with its groups), further tables become
//     Detail Report sections; text boxes, lines, rectangles, images, charts, matrices (cross tabs), page header/footer
//   - VB expressions are translated (Fields!X.Value -> [X], Parameters!P.Value -> ?P, Sum(...), IIf(...), DateAdd(...))
import type {
  Band,
  BandType,
  ChartElement,
  CrosstabElement,
  DataSourceDef,
  FieldDef,
  FieldType,
  HAlign,
  ImageElement,
  LineElement,
  ParameterDef,
  ReportDef,
  ReportElement,
  Row,
  ShapeElement,
  SqlParam,
  StyleProps,
  SummaryFunc,
  TableCell,
  TableElement,
  TextElement,
  VAlign,
} from '../model/types';
import { createElement, mmToPx, newBand, newReport, PAPER_SIZES, PT, uid } from '../model/defaults';
import { evalExpr, parse } from '../engine/expression';
import { isDate } from '../engine/format';
import type { DbConnection, Provider } from '../data/dbApi';

export interface RdlImportResult {
  report: ReportDef;
  warnings: string[];
}

// ------------------------------------------------------------------ xml helpers (namespace agnostic)
const kids = (el: Element | null | undefined, name: string): Element[] => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
const at = (el: Element | null | undefined, ...names: string[]): Element | null => names.reduce<Element | null>((e, n) => kid(e, n), el ?? null);
const txt = (el: Element | null | undefined, name: string) => kid(el, name)?.textContent ?? '';

/** RDL size ("2.5in", "10mm", "1cm", "12pt", "1pc") -> px */
export function size(s: string | null | undefined): number {
  const m = /^\s*(-?[\d.]+)\s*(in|cm|mm|pt|pc|px)?\s*$/i.exec(s ?? '');
  if (!m) return 0;
  const v = parseFloat(m[1]);
  switch ((m[2] ?? 'in').toLowerCase()) {
    case 'cm':
      return (v * 96) / 2.54;
    case 'mm':
      return (v * 96) / 25.4;
    case 'pt':
      return (v * 96) / 72;
    case 'pc':
      return v * 16;
    case 'px':
      return v;
    default:
      return v * 96;
  }
}

// ------------------------------------------------------------------ VB expressions -> ReportTool expressions
type VN =
  | { t: 'lit'; v: string | number | boolean | null; date?: boolean }
  | { t: 'id'; name: string }
  | { t: 'call'; name: string; args: VN[] }
  | { t: 'mcall'; o: VN; name: string; args: VN[] | null }
  | { t: 'bin'; op: string; l: VN; r: VN }
  | { t: 'un'; op: string; e: VN };
type VTok = { k: 'num' | 'str' | 'date' | 'id' | 'op' | 'eof'; v: string };

class Unsupported extends Error {}

function vbTokens(src: string): VTok[] {
  const out: VTok[] = [];
  const s = src.replace(/\s_\s*\r?\n/g, ' ');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^(\d*\.?\d+(?:[eE][+-]?\d+)?)[DFRILS@!#%&]?/.exec(s.slice(i))!;
      out.push({ k: 'num', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let v = '';
      i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            v += '"';
            i += 2;
            continue;
          }
          break;
        }
        v += s[i++];
      }
      i++;
      if (s[i] === 'c' || s[i] === 'C') i++; // char literal "x"c
      out.push({ k: 'str', v });
      continue;
    }
    if (c === '#') {
      const j = s.indexOf('#', i + 1);
      if (j < 0) throw new Unsupported('bad date literal');
      out.push({ k: 'date', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const j = s.indexOf(']', i + 1);
      if (j < 0) throw new Unsupported('missing ]');
      out.push({ k: 'id', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    const id = /^[A-Za-z_][\w]*(?:[!.](?:[A-Za-z_][\w]*|\[[^\]]+\]))*/.exec(s.slice(i));
    if (id) {
      out.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['<>', '<=', '>=', '&='].includes(two)) {
      out.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('&+-*/\\^=<>(),.'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    throw new Unsupported(`unexpected '${c}'`);
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

class VbParser {
  i = 0;
  constructor(private t: VTok[]) {}
  peek() {
    return this.t[this.i];
  }
  next() {
    return this.t[this.i++];
  }
  kw(...w: string[]) {
    const p = this.peek();
    return p.k === 'id' && w.includes(p.v.toLowerCase());
  }
  op(...o: string[]) {
    const p = this.peek();
    return p.k === 'op' && o.includes(p.v);
  }
  expect(o: string) {
    const p = this.next();
    if (p.k !== 'op' || p.v !== o) throw new Unsupported(`expected '${o}'`);
  }
  all(): VN {
    const e = this.or();
    if (this.peek().k !== 'eof') throw new Unsupported(`unexpected '${this.peek().v}'`);
    return e;
  }
  or(): VN {
    let l = this.and();
    while (this.kw('or', 'orelse', 'xor')) {
      const op = this.next().v.toLowerCase();
      if (op === 'xor') throw new Unsupported('Xor');
      l = { t: 'bin', op: 'or', l, r: this.and() };
    }
    return l;
  }
  and(): VN {
    let l = this.not();
    while (this.kw('and', 'andalso')) {
      this.next();
      l = { t: 'bin', op: 'and', l, r: this.not() };
    }
    return l;
  }
  not(): VN {
    if (this.kw('not')) {
      this.next();
      return { t: 'un', op: 'not', e: this.not() };
    }
    return this.cmp();
  }
  cmp(): VN {
    let l = this.concat();
    for (;;) {
      if (this.op('=', '<>', '<', '<=', '>', '>=')) {
        const op = this.next().v;
        l = { t: 'bin', op, l, r: this.concat() };
      } else if (this.kw('like', 'is', 'isnot')) {
        const op = this.next().v.toLowerCase();
        l = { t: 'bin', op, l, r: this.concat() };
      } else return l;
    }
  }
  concat(): VN {
    let l = this.add();
    while (this.op('&')) {
      this.next();
      l = { t: 'bin', op: '&', l, r: this.add() };
    }
    return l;
  }
  add(): VN {
    let l = this.mod();
    while (this.op('+', '-')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.mod() };
    }
    return l;
  }
  mod(): VN {
    let l = this.idiv();
    while (this.kw('mod')) {
      this.next();
      l = { t: 'bin', op: 'mod', l, r: this.idiv() };
    }
    return l;
  }
  idiv(): VN {
    let l = this.mul();
    while (this.op('\\')) {
      this.next();
      l = { t: 'bin', op: '\\', l, r: this.mul() };
    }
    return l;
  }
  mul(): VN {
    let l = this.unary();
    while (this.op('*', '/')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.unary() };
    }
    return l;
  }
  unary(): VN {
    if (this.op('-')) {
      this.next();
      return { t: 'un', op: '-', e: this.unary() };
    }
    if (this.op('+')) {
      this.next();
      return this.unary();
    }
    return this.pow();
  }
  pow(): VN {
    const l = this.postfix();
    if (this.op('^')) {
      this.next();
      return { t: 'bin', op: '^', l, r: this.unary() };
    }
    return l;
  }
  args(): VN[] {
    const out: VN[] = [];
    if (this.op(')')) {
      this.next();
      return out;
    }
    for (;;) {
      out.push(this.or());
      if (this.op(',')) {
        this.next();
        continue;
      }
      this.expect(')');
      return out;
    }
  }
  postfix(): VN {
    let e = this.primary();
    for (;;) {
      if (this.op('.')) {
        this.next();
        const n = this.next();
        if (n.k !== 'id') throw new Unsupported('member name expected');
        let args: VN[] | null = null;
        if (this.op('(')) {
          this.next();
          args = this.args();
        }
        e = { t: 'mcall', o: e, name: n.v, args };
      } else return e;
    }
  }
  primary(): VN {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'lit', v: Number(t.v) };
      case 'str':
        return { t: 'lit', v: t.v };
      case 'date':
        return { t: 'lit', v: t.v, date: true };
      case 'id': {
        const lw = t.v.toLowerCase();
        if (lw === 'true' || lw === 'false') return { t: 'lit', v: lw === 'true' };
        if (lw === 'nothing') return { t: 'lit', v: null };
        if (this.op('(')) {
          this.next();
          return { t: 'call', name: t.v, args: this.args() };
        }
        return { t: 'id', name: t.v };
      }
      case 'op':
        if (t.v === '(') {
          const e = this.or();
          this.expect(')');
          return e;
        }
    }
    throw new Unsupported(`unexpected '${t.v || 'end'}'`);
  }
}

const AGGS: Record<string, string> = { sum: 'Sum', avg: 'Avg', count: 'Count', min: 'Min', max: 'Max', first: 'First', last: 'Last', countdistinct: 'CountDistinct' };
const SIMPLE: Record<string, string> = {
  ucase: 'Upper', lcase: 'Lower', trim: 'Trim', ltrim: 'Trim', rtrim: 'Trim', len: 'Len', left: 'Left', right: 'Right', strreverse: 'Reverse',
  cstr: 'ToStr', cint: 'ToInt', clng: 'ToInt', cshort: 'ToInt', fix: 'ToInt', int: 'ToInt', cdbl: 'ToDouble', csng: 'ToDouble', val: 'ToDouble',
  cdec: 'ToDecimal', cdate: 'ToDate', datevalue: 'ToDate', cbool: 'ToBool', isnothing: 'IsNull', year: 'Year', month: 'Month', day: 'Day',
  hour: 'Hour', minute: 'Minute', second: 'Second', abs: 'Abs', round: 'Round', floor: 'Floor', ceiling: 'Ceiling', sqrt: 'Sqrt', exp: 'Exp',
  log: 'Log', log10: 'Log10', sign: 'Sign', pow: 'Power', rnd: 'Rnd', format: 'Format', dateserial: 'DateTime', isnumeric: 'IsNumeric',
};
const INTERVAL: Record<string, string> = {
  d: 'd', day: 'd', dd: 'd', y: 'y', dayofyear: 'y', m: 'm', month: 'm', mm: 'm', yyyy: 'yyyy', year: 'yyyy', h: 'h', hour: 'h',
  n: 'n', minute: 'n', mi: 'n', s: 's', second: 's', q: 'q', quarter: 'q', ww: 'ww', weekofyear: 'ww', w: 'w', weekday: 'w',
};

class VbToRt {
  constructor(
    private fields: Map<string, string>,
    private warn: (m: string) => void,
  ) {}
  str(s: string) {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  interval(n: VN): string {
    const raw = n.t === 'lit' ? String(n.v) : n.t === 'id' ? n.name.replace(/^.*\./, '') : '';
    const iv = INTERVAL[raw.toLowerCase()];
    if (!iv) throw new Unsupported('date interval');
    return iv;
  }
  gen(n: VN): string {
    switch (n.t) {
      case 'lit':
        if (n.v === null) return 'Null';
        if (typeof n.v === 'boolean') return n.v ? 'True' : 'False';
        if (typeof n.v === 'number') return String(n.v);
        if (n.date) {
          const d = new Date(n.v);
          if (isNaN(d.getTime())) throw new Unsupported('date literal');
          return `#${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}#`;
        }
        return this.str(n.v);
      case 'id':
        return this.id(n.name);
      case 'un':
        return n.op === 'not' ? `Not (${this.gen(n.e)})` : `-(${this.gen(n.e)})`;
      case 'bin':
        return this.bin(n);
      case 'call':
        return this.call(n.name, n.args);
      case 'mcall':
        return this.mcall(n);
    }
  }
  id(name: string): string {
    let m = /^Fields!(\[[^\]]+\]|\w+)(?:\.Value)?$/i.exec(name);
    if (m) {
      const f = m[1].replace(/^\[|\]$/g, '');
      return `[${this.fields.get(f.toLowerCase()) ?? f}]`;
    }
    m = /^Parameters!(\w+)(?:\.(?:Value|Label))?$/i.exec(name);
    if (m) return '?' + m[1];
    const lw = name.toLowerCase();
    if (lw === 'globals!pagenumber' || lw === 'globals!overallpagenumber') return 'PageNumber()';
    if (lw === 'globals!totalpages' || lw === 'globals!overalltotalpages') return 'PageCount()';
    if (lw === 'globals!executiontime') return 'Now()';
    if (lw === 'globals!reportname') return 'ReportName()';
    if (lw === 'today' || lw === 'datetime.today') return 'Today()';
    if (lw === 'now' || lw === 'datetime.now') return 'Now()';
    if (['vbcrlf', 'vbnewline', 'vblf', 'vbcr', 'environment.newline', 'controlchars.newline'].includes(lw)) return '"\\n"';
    if (lw === 'vbtab') return '"\\t"';
    throw new Unsupported(name);
  }
  bin(n: Extract<VN, { t: 'bin' }>): string {
    if ((n.op === 'is' || n.op === 'isnot') && n.r.t === 'lit' && n.r.v === null) return `${n.op === 'isnot' ? 'Not ' : ''}IsNull(${this.gen(n.l)})`;
    if (n.op === 'is' || n.op === 'isnot') throw new Unsupported('Is');
    const a = this.gen(n.l);
    const b = this.gen(n.r);
    switch (n.op) {
      case '&':
        return `Concat(${a}, ${b})`;
      case 'mod':
        return `(${a} % ${b})`;
      case '\\':
        return `ToInt(${a} / ${b})`;
      case '^':
        return `Power(${a}, ${b})`;
      case 'and':
        return `(${a} And ${b})`;
      case 'or':
        return `(${a} Or ${b})`;
      case 'like': {
        if (n.r.t === 'lit' && typeof n.r.v === 'string') return `Like(${a}, ${this.str(n.r.v.replace(/\*/g, '%').replace(/\?/g, '_'))})`;
        return `Like(${a}, ${b})`;
      }
      default:
        return `(${a} ${n.op} ${b})`;
    }
  }
  call(rawName: string, args: VN[]): string {
    const name = rawName.replace(/^(System\.)?(Math|Microsoft\.VisualBasic(\.(Strings|DateAndTime|Conversion|Interaction))?)\./i, '').toLowerCase();
    const G = (i: number) => (args[i] ? this.gen(args[i]) : 'Null');
    const all = () => args.map((a) => this.gen(a)).join(', ');
    if (AGGS[name]) {
      if (name === 'count' && !args.length) return 'Count()';
      return `${AGGS[name]}(${G(0)})`;
    }
    switch (name) {
      case 'countrows':
        return 'Count()';
      case 'rownumber':
        return 'RowNumber()';
      case 'runningvalue': {
        this.warn('RunningValue() was converted to a plain aggregate — set "Summary Running" on the control for a running total.');
        const fn = args[1]?.t === 'id' ? (AGGS[args[1].name.toLowerCase()] ?? 'Sum') : 'Sum';
        return `${fn}(${G(0)})`;
      }
      case 'iif':
        return `Iif(${all()})`;
      case 'switch':
        return `Iif(${all()}, Null)`;
      case 'choose': {
        const idx = G(0);
        return `Iif(${args
          .slice(1)
          .map((a, i) => `${idx} = ${i + 1}, ${this.gen(a)}`)
          .join(', ')}, Null)`;
      }
      case 'mid': {
        const st = args[1]?.t === 'lit' && typeof args[1].v === 'number' ? String(args[1].v - 1) : `${G(1)} - 1`;
        return args.length > 2 ? `Substring(${G(0)}, ${st}, ${G(2)})` : `Substring(${G(0)}, ${st})`;
      }
      case 'instr':
        if (args.length > 2) return `(IndexOf(${G(1)}, ${G(2)}) + 1)`;
        return `(IndexOf(${G(0)}, ${G(1)}) + 1)`;
      case 'replace':
        return `Replace(${G(0)}, ${G(1)}, ${G(2)})`;
      case 'formatnumber':
        return `Format(${G(0)}, 'n${args[1]?.t === 'lit' && typeof args[1].v === 'number' ? args[1].v : 2}')`;
      case 'formatcurrency':
        return `Format(${G(0)}, 'c')`;
      case 'formatpercent':
        return `Format(${G(0)}, 'p')`;
      case 'formatdatetime':
        return `Format(${G(0)}, 'd')`;
      case 'string.format':
        return args.length > 1 ? `Format(${G(1)}, ${G(0)}${args.length > 2 ? ', ' + args.slice(2).map((a) => this.gen(a)).join(', ') : ''})` : G(0);
      case 'string.isnullorempty':
        return `IsNullOrEmpty(${G(0)})`;
      case 'weekday':
        return `(DayOfWeek(${G(0)}) + 1)`;
      case 'today':
        return 'Today()';
      case 'now':
        return 'Now()';
      case 'dateadd': {
        const iv = this.interval(args[0]);
        const n = G(1);
        const d = G(2);
        const map: Record<string, string> = { d: `AddDays(${d}, ${n})`, y: `AddDays(${d}, ${n})`, w: `AddDays(${d}, ${n})`, ww: `AddDays(${d}, (${n}) * 7)`, m: `AddMonths(${d}, ${n})`, q: `AddMonths(${d}, (${n}) * 3)`, yyyy: `AddYears(${d}, ${n})`, h: `AddHours(${d}, ${n})`, n: `AddMinutes(${d}, ${n})` };
        if (!map[iv]) throw new Unsupported('DateAdd interval');
        return map[iv];
      }
      case 'datediff': {
        const iv = this.interval(args[0]);
        const fn = iv === 'd' || iv === 'y' || iv === 'w' ? 'DateDiffDay' : iv === 'm' ? 'DateDiffMonth' : iv === 'yyyy' ? 'DateDiffYear' : null;
        if (!fn) throw new Unsupported('DateDiff interval');
        return `${fn}(${G(1)}, ${G(2)})`;
      }
      case 'datepart': {
        const iv = this.interval(args[0]);
        const d = G(1);
        const map: Record<string, string> = { d: `Day(${d})`, m: `Month(${d})`, yyyy: `Year(${d})`, q: `Quarter(${d})`, y: `DayOfYear(${d})`, w: `(DayOfWeek(${d}) + 1)`, h: `Hour(${d})`, n: `Minute(${d})`, s: `Second(${d})` };
        if (!map[iv]) throw new Unsupported('DatePart interval');
        return map[iv];
      }
    }
    if (SIMPLE[name]) {
      if (name === 'isnumeric') throw new Unsupported('IsNumeric');
      return `${SIMPLE[name]}(${all()})`;
    }
    throw new Unsupported(rawName + '()');
  }
  mcall(n: Extract<VN, { t: 'mcall' }>): string {
    const o = this.gen(n.o);
    const a = (n.args ?? []).map((x) => this.gen(x));
    switch (n.name.toLowerCase()) {
      case 'tostring':
        return a.length ? `Format(${o}, ${a[0]})` : `ToStr(${o})`;
      case 'trim':
        return `Trim(${o})`;
      case 'toupper':
        return `Upper(${o})`;
      case 'tolower':
        return `Lower(${o})`;
      case 'length':
        return `Len(${o})`;
      case 'substring':
        return `Substring(${o}, ${a.join(', ')})`;
      case 'contains':
        return `Contains(${o}, ${a[0]})`;
      case 'startswith':
        return `StartsWith(${o}, ${a[0]})`;
      case 'endswith':
        return `EndsWith(${o}, ${a[0]})`;
      case 'replace':
        return `Replace(${o}, ${a[0]}, ${a[1]})`;
      case 'value':
        return o;
    }
    throw new Unsupported('.' + n.name);
  }
}

// ------------------------------------------------------------------ importer
interface DsInfo {
  id: string;
  fields: Map<string, string>; // RDL field name (lower) -> data column
  filter: string;
}
interface Placed {
  el: Element;
  x: number;
  y: number;
}
interface Leaf {
  kind: 'header' | 'footer' | 'detail' | 'groupHeader' | 'groupFooter';
  group?: number;
  repeat?: boolean;
  row: number; // body row index, -1 = synthetic (row header cell of a group)
  hdr: (Element | null)[];
  height?: number;
}

class Importer {
  r: ReportDef = newReport();
  warnings: string[] = [];
  private images = new Map<string, string>();
  private sets = new Map<string, DsInfo>();
  private sources = new Map<string, { provider: string; cs: string }>();
  private exprCtx: DsInfo | null = null;

  constructor(
    private doc: Document,
    private fileName: string,
    private connections: DbConnection[],
  ) {}

  warn(m: string) {
    if (!this.warnings.includes(m)) this.warnings.push(m);
  }

  /** VB value -> { expression } or { text } (static text, or "{expr}" interpolation for mixed runs) */
  conv(value: string, what: string): string | null {
    const v = value.trim();
    if (!v.startsWith('=')) return null;
    try {
      const node = new VbParser(vbTokens(v.slice(1))).all();
      const out = new VbToRt(this.exprCtx?.fields ?? new Map(), (m) => this.warn(m)).gen(node);
      parse(out);
      return out;
    } catch (e) {
      this.warn(`${what}: "${v}" could not be converted (${(e as Error).message || 'unsupported'}) — kept as text.`);
      return null;
    }
  }
  /** ="Total: " & Sum(…) & " items"  ->  "Total: {Sum(…)} items" (null when the value is not such a concatenation) */
  convText(value: string, what: string): string | null {
    const v = value.trim();
    if (!v.startsWith('=')) return null;
    try {
      const node = new VbParser(vbTokens(v.slice(1))).all();
      const parts: VN[] = [];
      const flat = (n: VN) => {
        if (n.t === 'bin' && n.op === '&') {
          flat(n.l);
          flat(n.r);
        } else parts.push(n);
      };
      flat(node);
      if (parts.length < 2 || !parts.some((p) => p.t === 'lit' && typeof p.v === 'string')) return null;
      const g = new VbToRt(this.exprCtx?.fields ?? new Map(), (m) => this.warn(m));
      let out = '';
      for (let p of parts) {
        if (p.t === 'lit' && typeof p.v === 'string' && !p.date) out += p.v.replace(/\{/g, '{{').replace(/\}/g, '}}');
        else if (p.t === 'id' && /^(vbcrlf|vbnewline|vblf|environment\.newline)$/i.test(p.name)) out += '\n';
        else {
          if (p.t === 'call' && /^cstr$/i.test(p.name) && p.args.length === 1) p = p.args[0];
          else if (p.t === 'mcall' && /^tostring$/i.test(p.name) && !p.args?.length) p = p.o;
          const e = g.gen(p);
          parse(e);
          out += `{${e}}`;
        }
      }
      return out;
    } catch (e) {
      this.warn(`${what}: "${v}" could not be converted (${(e as Error).message || 'unsupported'}) — kept as text.`);
      return null;
    }
  }
  /** expression or static value: '=…' converted, otherwise quoted literal */
  convOrLit(value: string, what: string): string {
    const v = value.trim();
    if (v.startsWith('=')) return this.conv(v, what) ?? "''";
    return "'" + v.replace(/'/g, "''") + "'";
  }

  // ---------------------------------------------------------------- styles
  private color(v: string | null | undefined): string | undefined {
    const c = (v ?? '').trim();
    if (!c || c.startsWith('=') || /^(transparent|no color)$/i.test(c)) return undefined;
    return c;
  }
  private boxStyle(st: Element | null): StyleProps {
    const out: StyleProps = {};
    if (!st) return out;
    const bg = this.color(txt(st, 'BackgroundColor'));
    if (bg) out.backColor = bg;
    const va = txt(st, 'VerticalAlign');
    if (va && !va.startsWith('=')) out.vAlign = ({ Top: 'top', Middle: 'middle', Bottom: 'bottom' } as Record<string, VAlign>)[va] ?? undefined;
    const pl = txt(st, 'PaddingLeft');
    if (pl && !pl.startsWith('=')) out.padding = Math.round(size(pl));
    const side = (tag: string) => {
      const b = kid(st, tag);
      return b ? { style: txt(b, 'Style'), color: txt(b, 'Color'), width: txt(b, 'Width') } : null;
    };
    const def = side('Border');
    let letters = '';
    let col: string | undefined;
    let width = 0;
    let ls: StyleProps['borderStyle'];
    for (const [tag, l] of [
      ['TopBorder', 't'],
      ['RightBorder', 'r'],
      ['BottomBorder', 'b'],
      ['LeftBorder', 'l'],
    ] as const) {
      const sd = side(tag);
      const style = sd?.style || def?.style || 'None';
      if (style && style !== 'None' && !style.startsWith('=')) {
        letters += l;
        col ??= this.color(sd?.color || def?.color) ?? undefined;
        width ||= size(sd?.width || def?.width || '1pt');
        ls ??= /dash/i.test(style) ? 'dashed' : /dot/i.test(style) ? 'dotted' : 'solid';
      }
    }
    if (letters) {
      out.borders = letters;
      out.borderColor = col ?? '#000000';
      out.borderWidth = Math.max(1, Math.round(width));
      out.borderStyle = ls ?? 'solid';
    } else out.borders = '';
    return out;
  }
  private runStyle(st: Element | null): StyleProps {
    const out: StyleProps = {};
    if (!st) return out;
    const ff = txt(st, 'FontFamily');
    if (ff && !ff.startsWith('=')) out.fontFamily = ff;
    const fs = txt(st, 'FontSize');
    if (fs && !fs.startsWith('=')) out.fontSize = Math.round((size(fs) / PT) * 2) / 2;
    const fw = txt(st, 'FontWeight');
    if (fw && !fw.startsWith('=')) out.bold = /bold|semibold|extrabold|heavy|black/i.test(fw) || Number(fw) >= 600;
    const fst = txt(st, 'FontStyle');
    if (fst && !fst.startsWith('=')) out.italic = /italic/i.test(fst);
    const td = txt(st, 'TextDecoration');
    if (td && !td.startsWith('=')) {
      out.underline = /underline/i.test(td);
      out.strike = /linethrough/i.test(td);
    }
    const c = this.color(txt(st, 'Color'));
    if (c) out.color = c;
    return out;
  }
  private align(st: Element | null): HAlign | undefined {
    const a = txt(st, 'TextAlign');
    return ({ Left: 'left', Center: 'center', Right: 'right', Justify: 'justify' } as Record<string, HAlign>)[a];
  }

  // ---------------------------------------------------------------- report items -> elements
  private add<T extends ReportElement>(tool: Parameters<typeof createElement>[0], bandId: string, x: number, y: number, w: number, h: number, name: string, extra: Partial<T> = {}): T {
    const el = createElement(tool, bandId, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), this.r.elements, extra as Partial<ReportElement>) as T;
    el.width = Math.max(1, Math.round(w));
    el.height = Math.max(1, Math.round(h));
    if (name && /^\w+$/.test(name) && !this.r.elements.some((e) => e.name === name)) el.name = name;
    this.r.elements.push(el);
    return el;
  }
  private geom(el: Element) {
    return { x: size(txt(el, 'Left')), y: size(txt(el, 'Top')), w: size(txt(el, 'Width')), h: size(txt(el, 'Height')) };
  }
  private hidden(el: Element): string | undefined {
    const h = txt(kid(el, 'Visibility'), 'Hidden').trim();
    if (!h) return undefined;
    if (/^true$/i.test(h)) return 'False';
    if (/^false$/i.test(h)) return undefined;
    const c = this.conv(h, 'Visibility');
    return c ? `Not (${c})` : undefined;
  }

  /** textbox -> text, expression, format and style */
  private textboxContent(tb: Element): { text: string; expression: string; format: string; style: StyleProps } {
    const paras = kids(kid(tb, 'Paragraphs'), 'Paragraph');
    let style: StyleProps = this.boxStyle(kid(tb, 'Style'));
    let format = '';
    const runs: { value: string; para: number }[] = [];
    paras.forEach((p, pi) => {
      if (pi === 0) {
        const a = this.align(kid(p, 'Style'));
        if (a) style.textAlign = a;
      }
      for (const run of kids(kid(p, 'TextRuns'), 'TextRun')) {
        const rs = kid(run, 'Style');
        if (!runs.length) {
          style = { ...style, ...this.runStyle(rs) };
          const f = txt(rs, 'Format');
          if (f && !f.startsWith('=')) format = f;
        }
        runs.push({ value: txt(run, 'Value'), para: pi });
      }
    });
    if (runs.length === 1 && runs[0].value.trim().startsWith('=')) {
      const asText = this.convText(runs[0].value, `Text box ${tb.getAttribute('Name')}`);
      if (asText !== null) return { text: asText, expression: '', format: '', style };
      const e = this.conv(runs[0].value, `Text box ${tb.getAttribute('Name')}`);
      return e ? { text: '', expression: e, format, style } : { text: runs[0].value, expression: '', format: '', style };
    }
    let text = '';
    let lastPara = 0;
    for (const run of runs) {
      if (run.para !== lastPara) text += '\n'.repeat(run.para - lastPara);
      lastPara = run.para;
      if (run.value.trim().startsWith('=')) {
        const e = this.conv(run.value, `Text box ${tb.getAttribute('Name')}`);
        text += e ? `{${e}}` : run.value;
      } else text += run.value.replace(/\{/g, '{{').replace(/\}/g, '}}');
    }
    return { text, expression: '', format: runs.some((r) => r.value.trim().startsWith('=')) ? '' : format, style };
  }

  /** place one report item (and the children of rectangles) into a band */
  item(it: Element, bandId: string, ox: number, oy: number) {
    const g = this.geom(it);
    const x = ox + g.x;
    const y = oy + g.y;
    const name = it.getAttribute('Name') ?? '';
    switch (it.localName) {
      case 'Textbox': {
        const c = this.textboxContent(it);
        const el = this.add<TextElement>('text', bandId, x, y, g.w, g.h, name);
        el.text = c.text;
        el.expression = c.expression;
        el.format = c.format;
        el.style = c.style;
        el.canGrow = txt(it, 'CanGrow') !== 'false';
        el.canShrink = txt(it, 'CanShrink') === 'true';
        el.wordWrap = true;
        el.visibleExpr = this.hidden(it);
        break;
      }
      case 'Line': {
        const st = at(it, 'Style', 'Border');
        let { w, h } = g;
        let lx = x;
        let ly = y;
        let dir: LineElement['direction'] = 'slantDown';
        if (Math.abs(h) < 1) {
          dir = 'horizontal';
          ly = y - 4;
          h = 8;
        } else if (Math.abs(w) < 1) {
          dir = 'vertical';
          lx = x - 4;
          w = 8;
        } else {
          dir = w > 0 === h > 0 ? 'slantDown' : 'slantUp';
          lx = Math.min(x, x + w);
          ly = Math.min(y, y + h);
        }
        const el = this.add<LineElement>('line', bandId, lx, ly, Math.abs(w), Math.abs(h), name);
        el.direction = dir;
        el.lineColor = this.color(txt(st, 'Color')) ?? '#000000';
        el.lineWidth = Math.max(1, Math.round(size(txt(st, 'Width') || '1pt')));
        const s = txt(st, 'Style');
        el.lineStyle = /dash/i.test(s) ? 'dashed' : /dot/i.test(s) ? 'dotted' : 'solid';
        el.visibleExpr = this.hidden(it);
        break;
      }
      case 'Rectangle': {
        const st = this.boxStyle(kid(it, 'Style'));
        if (st.backColor || st.borders) {
          const el = this.add<ShapeElement>('shape', bandId, x, y, g.w, g.h, name);
          el.fillColor = st.backColor ?? '';
          el.lineWidth = st.borders ? (st.borderWidth ?? 1) : 0;
          el.lineColor = st.borderColor ?? '#000000';
          el.lineStyle = st.borderStyle ?? 'solid';
        }
        for (const c of Array.from(kid(it, 'ReportItems')?.children ?? [])) this.item(c, bandId, x, y);
        break;
      }
      case 'Image': {
        const el = this.add<ImageElement>('image', bandId, x, y, g.w, g.h, name);
        const src = txt(it, 'Source');
        const v = txt(it, 'Value');
        if (src === 'Embedded') el.src = this.images.get(v) ?? '';
        else if (v.trim().startsWith('=')) {
          el.expression = this.conv(v, `Image ${name}`) ?? '';
          if (src === 'Database') this.warn(`Image "${name}" reads binary data from the database — ReportTool expects a URL or data: URL in that field.`);
        } else el.src = v;
        const sz = txt(it, 'Sizing');
        el.sizing = sz === 'Fit' ? 'stretch' : sz === 'Clip' ? 'cover' : 'zoom';
        el.visibleExpr = this.hidden(it);
        break;
      }
      case 'Chart':
        this.chart(it, bandId, x, y);
        break;
      case 'Tablix':
        // a table nested inside a band: matrix -> cross tab, otherwise its cells as a static grid
        if (!this.crosstab(it, bandId, x, y)) this.staticTablix(it, bandId, x, y);
        break;
      case 'Subreport': {
        const el = this.add<TextElement>('text', bandId, x, y, g.w, Math.max(g.h, 20), name);
        el.text = `[Subreport: ${txt(it, 'ReportName')}]`;
        el.style = { italic: true, color: '#6b7280', borders: 'tlbr', borderColor: '#d1d5db' };
        this.warn(`Subreport "${txt(it, 'ReportName')}" was replaced by a placeholder — use a Detail Report section instead.`);
        break;
      }
      default:
        this.warn(`${it.localName} "${name}" is not supported and was left out.`);
    }
  }

  private chart(it: Element, bandId: string, x: number, y: number) {
    const g = this.geom(it);
    const name = it.getAttribute('Name') ?? '';
    const el = this.add<ChartElement>('chart', bandId, x, y, g.w, g.h, name);
    const series = at(it, 'ChartData', 'ChartSeriesCollection', 'ChartSeries');
    const type = txt(series, 'Type');
    const sub = txt(series, 'Subtype');
    el.chartType = type === 'Bar' ? 'bar' : type === 'Line' ? 'line' : type === 'Area' ? 'area' : type === 'Shape' ? (/doughnut/i.test(sub) ? 'doughnut' : 'pie') : 'column';
    const yv = txt(at(series, 'ChartDataPoints', 'ChartDataPoint', 'ChartDataPointValues'), 'Y');
    const conv = this.conv(yv, `Chart ${name}`) ?? '';
    const m = /^(Sum|Avg|Count|Min|Max|CountDistinct|First|Last)\((.*)\)$/i.exec(conv);
    if (m && validExpr(m[2])) {
      el.aggregate = (m[1].toLowerCase() === 'countdistinct' ? 'countDistinct' : m[1].toLowerCase()) as SummaryFunc;
      el.value = m[2];
    } else el.value = conv;
    const grp = (h: string) => txt(at(it, h, 'ChartMembers', 'ChartMember', 'Group', 'GroupExpressions'), 'GroupExpression');
    el.argument = this.conv(grp('ChartCategoryHierarchy'), `Chart ${name}`) ?? '';
    const s = grp('ChartSeriesHierarchy');
    el.series = s ? (this.conv(s, `Chart ${name}`) ?? '') : '';
    el.title = txt(at(it, 'ChartTitles', 'ChartTitle'), 'Caption');
    el.showLegend = txt(at(it, 'ChartLegends', 'ChartLegend'), 'Hidden') !== 'true';
    el.showLabels = /true/i.test(txt(at(series, 'ChartDataPoints', 'ChartDataPoint', 'ChartDataLabel'), 'Visible'));
  }

  /** a matrix (row group x column group) -> cross tab element; false when it is not one */
  private crosstab(tx: Element, bandId: string, x: number, y: number): boolean {
    const colTop = kids(at(tx, 'TablixColumnHierarchy', 'TablixMembers'), 'TablixMember');
    const rowTop = kids(at(tx, 'TablixRowHierarchy', 'TablixMembers'), 'TablixMember');
    const colDyn = colTop.find((m) => kid(m, 'Group') && kid(kid(m, 'Group'), 'GroupExpressions'));
    const rowDyn = rowTop.find((m) => kid(m, 'Group') && kid(kid(m, 'Group'), 'GroupExpressions'));
    if (!colDyn || !rowDyn) return false;
    const name = tx.getAttribute('Name') ?? '';
    const ge = (m: Element) => this.conv(txt(at(m, 'Group', 'GroupExpressions'), 'GroupExpression'), `Matrix ${name}`) ?? '';
    const g = this.geom(tx);
    const el = this.add<CrosstabElement>('crosstab', bandId, x, y, g.w, g.h, name);
    el.rowField = ge(rowDyn);
    el.columnField = ge(colDyn);
    const cell = at(tx, 'TablixBody', 'TablixRows', 'TablixRow', 'TablixCells', 'TablixCell', 'CellContents', 'Textbox');
    const c = cell ? this.textboxContent(cell) : null;
    const m = /^(Sum|Avg|Count|Min|Max|CountDistinct|First|Last)\((.*)\)$/i.exec(c?.expression ?? '');
    if (m && validExpr(m[2])) {
      el.aggregate = (m[1].toLowerCase() === 'countdistinct' ? 'countDistinct' : m[1].toLowerCase()) as SummaryFunc;
      el.valueField = m[2];
    } else el.valueField = c?.expression ?? '';
    el.format = c?.format || el.format;
    el.showRowTotals = colTop.some((m) => !kid(m, 'Group'));
    el.showColumnTotals = rowTop.some((m) => !kid(m, 'Group'));
    el.rowHeaderWidth = Math.round(size(txt(kid(rowDyn, 'TablixHeader'), 'Size')) || 120);
    el.cellWidth = Math.round(size(txt(at(tx, 'TablixBody', 'TablixColumns', 'TablixColumn'), 'Width')) || 70);
    el.rowHeight = Math.round(size(txt(at(tx, 'TablixBody', 'TablixRows', 'TablixRow'), 'Height')) || 22);
    const corner = at(tx, 'TablixCorner', 'TablixCornerRows', 'TablixCornerRow', 'TablixCornerCell', 'CellContents', 'Textbox');
    el.corner = corner ? this.textboxContent(corner).text : '';
    return true;
  }

  /** the cells of a tablix without data grouping, placed as a static grid */
  private staticTablix(tx: Element, bandId: string, x: number, y: number) {
    const widths = kids(at(tx, 'TablixBody', 'TablixColumns'), 'TablixColumn').map((c) => size(txt(c, 'Width')));
    let yy = y;
    for (const row of kids(at(tx, 'TablixBody', 'TablixRows'), 'TablixRow')) {
      const h = size(txt(row, 'Height'));
      this.rowToBand(row, widths, [], [], bandId, x, yy, h);
      yy += h;
    }
  }

  /** one tablix row: text box cells -> a one-row table; other cell contents -> elements */
  rowToBand(row: Element | null, widths: number[], hdrWidths: number[], hdrCells: (Element | null)[], bandId: string, x: number, y: number, h: number) {
    const cells: { w: number; content: Element | null }[] = [];
    hdrCells.forEach((c, i) => cells.push({ w: hdrWidths[i] ?? 0, content: c ? firstItem(kid(c, 'CellContents')) : null }));
    if (row) {
      let ci = 0;
      for (const cell of kids(kid(row, 'TablixCells'), 'TablixCell')) {
        const cc = kid(cell, 'CellContents');
        const span = Math.max(1, Number(txt(cc, 'ColSpan')) || 1);
        const w = widths.slice(ci, ci + span).reduce((a, b) => a + b, 0);
        cells.push({ w, content: firstItem(cc) });
        ci += span;
      }
    }
    if (!cells.length) return;
    const isText = (e: Element | null) => !e || e.localName === 'Textbox';
    if (cells.some((c) => c.content?.localName === 'Textbox')) {
      const t = this.add<TableElement>('table', bandId, x, y, cells.reduce((a, c) => a + c.w, 0), h, '');
      t.columns = cells.map((c) => Math.round(c.w));
      t.width = t.columns.reduce((a, b) => a + b, 0);
      t.style = {};
      t.canGrow = true;
      const tc: TableCell[] = cells.map((c) => {
        if (c.content?.localName !== 'Textbox') return { text: '', expression: '', format: '', summaryFunc: 'none', style: { borders: '' } };
        const v = this.textboxContent(c.content);
        return { text: v.text, expression: v.expression, format: v.format, summaryFunc: 'none', style: v.style };
      });
      t.rows = [{ height: Math.round(h), cells: tc }];
      t.height = Math.round(h);
    }
    // non-text cell contents (rectangles of a list, images, charts, …)
    let cx = x;
    for (const c of cells) {
      if (c.content && !isText(c.content)) {
        if (c.content.localName === 'Rectangle') {
          const st = this.boxStyle(kid(c.content, 'Style'));
          const band = this.r.bands.find((b) => b.id === bandId);
          if (st.backColor && band && cells.length === 1) band.backColor = st.backColor;
          for (const it of Array.from(kid(c.content, 'ReportItems')?.children ?? [])) this.item(it, bandId, cx, y);
        } else {
          // the cell gives the size of the item
          const copy = c.content.cloneNode(true) as Element;
          for (const [tag, v] of [
            ['Left', '0in'],
            ['Top', '0in'],
            ['Width', `${c.w / 96}in`],
            ['Height', `${h / 96}in`],
          ] as const) {
            let e = kid(copy, tag);
            if (!e) {
              e = copy.ownerDocument.createElementNS(copy.namespaceURI, tag);
              copy.appendChild(e);
            }
            e.textContent = v;
          }
          this.item(copy, bandId, cx, y);
        }
      }
      cx += c.w;
    }
  }

  // ---------------------------------------------------------------- tablix -> bands
  private classify(tx: Element): { groups: { exprs: string[]; desc: boolean; hidden?: string }[]; leaves: Leaf[]; detailSort: Element | null; hdrWidths: number[] } {
    const groups: { exprs: string[]; desc: boolean; hidden?: string }[] = [];
    const leaves: Leaf[] = [];
    const hdrWidths: number[] = [];
    let row = 0;
    let detailSort: Element | null = null;
    type HdrSlot = { cell: Element; used: boolean; group: number | null };
    const walk = (members: Element[], cur: number | null, inDetails: boolean, path: HdrSlot[]) => {
      let seenDynamic = false;
      for (const m of members) {
        const grp = kid(m, 'Group');
        const childList = kids(kid(m, 'TablixMembers'), 'TablixMember');
        const header = kid(m, 'TablixHeader');
        const exprs = kids(kid(grp, 'GroupExpressions'), 'GroupExpression').map((e) => e.textContent ?? '');
        let myGroup = cur;
        if (grp && exprs.length) {
          myGroup = groups.length;
          const dir = txt(at(m, 'SortExpressions', 'SortExpression'), 'Direction');
          groups.push({ exprs, desc: dir === 'Descending' });
        }
        const p = [...path];
        if (header) {
          const d = p.length;
          hdrWidths[d] = Math.max(hdrWidths[d] ?? 0, size(txt(header, 'Size')));
          p.push({ cell: header, used: false, group: grp && exprs.length ? myGroup : null });
        }
        const isDetails = !!grp && !exprs.length;
        if (isDetails) detailSort = kid(m, 'SortExpressions');
        if (childList.length) walk(childList, myGroup, inDetails || isDetails, p);
        else {
          let kind: Leaf['kind'];
          if (grp && exprs.length) kind = 'groupHeader';
          else if (inDetails || isDetails) kind = 'detail';
          else if (cur === null) kind = seenDynamic ? 'footer' : 'header';
          else kind = seenDynamic ? 'groupFooter' : 'groupHeader';
          const hdr = p.map((s) => {
            if (s.used) return null;
            s.used = true;
            return s.cell;
          });
          // a group's row header cell lands on a detail row -> give the group its own header row
          const gslot = p.find((s) => s.group !== null && hdr.includes(s.cell));
          if (gslot && kind === 'detail') {
            leaves.push({ kind: 'groupHeader', group: gslot.group!, row: -1, hdr: hdr.map((c) => (c && p.find((s) => s.cell === c)?.group !== null ? c : null)) });
            leaves.push({ kind, group: myGroup ?? undefined, row: row++, hdr: hdr.map((c) => (c && p.find((s) => s.cell === c)?.group === null ? c : null)), repeat: txt(m, 'RepeatOnNewPage') === 'true' });
          } else leaves.push({ kind, group: kind === 'groupHeader' || kind === 'groupFooter' ? (myGroup ?? undefined) : undefined, row: row++, hdr, repeat: txt(m, 'RepeatOnNewPage') === 'true' });
        }
        if (grp) seenDynamic = true;
      }
    };
    walk(kids(at(tx, 'TablixRowHierarchy', 'TablixMembers'), 'TablixMember'), null, false, []);
    return { groups, leaves, detailSort, hdrWidths: hdrWidths.map((w) => w ?? 0) };
  }

  sortDefs(sorts: Element | null): { expression: string; dir: 'asc' | 'desc' }[] {
    return kids(sorts, 'SortExpression')
      .map((s) => ({ expression: this.conv(txt(s, 'Value'), 'Sort') ?? '', dir: txt(s, 'Direction') === 'Descending' ? ('desc' as const) : ('asc' as const) }))
      .filter((s) => s.expression);
  }
  filterOf(el: Element | null, what: string): string {
    const parts: string[] = [];
    for (const f of kids(kid(el, 'Filters'), 'Filter')) {
      let e = this.conv(txt(f, 'FilterExpression'), what);
      const valEls = kids(kid(f, 'FilterValues'), 'FilterValue');
      const vals = valEls.map((v) => {
        const raw = (v.textContent ?? '').trim();
        if (raw.startsWith('=')) return this.convOrLit(raw, what);
        const dt = v.getAttribute('DataType') ?? '';
        if (dt === 'Boolean' || /^(true|false)$/i.test(raw)) return /^true$/i.test(raw) ? 'True' : 'False';
        if ((dt === 'Integer' || dt === 'Float') && raw !== '' && !isNaN(Number(raw))) return raw;
        if (dt === 'DateTime' && !isNaN(Date.parse(raw))) return `#${raw.slice(0, 10)}#`;
        return "'" + raw.replace(/'/g, "''") + "'";
      });
      const op = txt(f, 'Operator');
      if (!e) continue;
      // "=CBool(condition) Equal true" is just the condition
      if (op === 'Equal' && (vals[0] === 'True' || vals[0] === 'False')) {
        const inner = /^ToBool\((.*)\)$/.exec(e);
        if (inner && validExpr(inner[1])) e = inner[1];
        parts.push(vals[0] === 'True' ? `(${e})` : `Not (${e})`);
        continue;
      }
      const ops: Record<string, string> = { Equal: '=', NotEqual: '!=', GreaterThan: '>', GreaterThanOrEqual: '>=', LessThan: '<', LessThanOrEqual: '<=' };
      if (ops[op]) parts.push(`(${e} ${ops[op]} ${vals[0] ?? 'Null'})`);
      else if (op === 'Like') parts.push(`Like(${e}, ${(vals[0] ?? "''").replace(/\*/g, '%')})`);
      else if (op === 'In') parts.push(`(${e} In (${vals.join(', ')}))`);
      else if (op === 'Between') parts.push(`Between(${e}, ${vals[0]}, ${vals[1]})`);
      else this.warn(`${what}: filter operator ${op} is not supported.`);
    }
    return parts.join(' And ');
  }

  /** the main data table / list -> groups, group header/footer, detail */
  mainTablix(tx: Element, set: DsInfo, headerBand: Band, footerBand: Band, headerTop: number) {
    const r = this.r;
    this.exprCtx = set;
    r.dataSourceId = set.id;
    const c = this.classify(tx);
    const widths = kids(at(tx, 'TablixBody', 'TablixColumns'), 'TablixColumn').map((col) => size(txt(col, 'Width')));
    const rows = kids(at(tx, 'TablixBody', 'TablixRows'), 'TablixRow');
    const x0 = size(txt(tx, 'Left'));
    const filter = [set.filter, this.filterOf(tx, 'Table filter')].filter(Boolean).join(' And ');
    r.filter = filter;
    r.sort = this.sortDefs(c.detailSort).map((s) => ({ id: uid('s'), ...s }));
    const groupIds = c.groups.map((g, i) => {
      if (g.exprs.length > 1) this.warn(`Group ${i + 1} has several group expressions — only the first was used.`);
      const id = uid('g');
      r.groups.push({ id, expression: this.conv(g.exprs[0], `Group ${i + 1}`) ?? '', sort: g.desc ? 'desc' : 'asc', keepWithFirstDetail: true });
      return id;
    });
    const detail = r.bands.find((b) => b.type === 'detail')!;
    detail.height = 0;
    const fills = new Map<string, number>();
    const pageHeader = r.bands.find((b) => b.type === 'pageHeader');
    const bandFor = (l: Leaf): Band => {
      const find = (t: BandType, gid?: string) => {
        let b = r.bands.find((x) => x.type === t && (gid === undefined || x.groupId === gid));
        if (!b) {
          b = newBand(t, gid, 0);
          b.height = 0;
          r.bands.push(b);
        }
        return b;
      };
      switch (l.kind) {
        case 'header':
          return l.repeat && pageHeader ? pageHeader : headerBand;
        case 'footer':
          return footerBand;
        case 'groupHeader': {
          const b = find('groupHeader', groupIds[l.group ?? 0]);
          if (l.repeat) b.repeatEveryPage = true;
          return b;
        }
        case 'groupFooter':
          return find('groupFooter', groupIds[l.group ?? 0]);
        default:
          return detail;
      }
    };
    for (const l of c.leaves) {
      const band = bandFor(l);
      const row = l.row >= 0 ? (rows[l.row] ?? null) : null;
      const h = row ? size(txt(row, 'Height')) : size(txt(at(l.hdr.find(Boolean) ?? null, 'Size'), 'Size')) || 24;
      const hh = row ? h : Math.max(20, size(txt(rows[0], 'Height')) || 24);
      let y = fills.get(band.id) ?? (band === headerBand ? headerTop : band === footerBand ? 0 : band.height);
      if (band === pageHeader && !fills.has(band.id)) y = 0;
      this.rowToBand(row, widths, c.hdrWidths, l.hdr, band.id, x0, y, hh);
      y += hh;
      fills.set(band.id, y);
      band.height = Math.max(band.height, Math.ceil(y));
    }
    if (c.leaves.length !== rows.length + c.leaves.filter((l) => l.row < 0).length) this.warn(`Table "${tx.getAttribute('Name')}": its row layout could not be fully matched — check the bands.`);
    if (!r.bands.some((b) => b.type === 'detail' && b.height > 0)) detail.height = 0;
  }

  /** a further data table / list -> Detail Report section printed once */
  sectionTablix(tx: Element, set: DsInfo) {
    const r = this.r;
    this.exprCtx = set;
    const c = this.classify(tx);
    if (c.groups.length) this.warn(`Table "${tx.getAttribute('Name')}" has groups — imported as a section without groups.`);
    const id = uid('dr');
    r.detailReports.push({
      id,
      name: tx.getAttribute('Name') || 'Detail Report',
      dataSourceId: set.id,
      parentId: null,
      printMode: 'once',
      keys: [],
      filter: [set.filter, this.filterOf(tx, 'Table filter')].filter(Boolean).join(' And '),
      sort: this.sortDefs(c.detailSort).map((s) => ({ id: uid('s'), ...s })),
    });
    const widths = kids(at(tx, 'TablixBody', 'TablixColumns'), 'TablixColumn').map((col) => size(txt(col, 'Width')));
    const rows = kids(at(tx, 'TablixBody', 'TablixRows'), 'TablixRow');
    const x0 = size(txt(tx, 'Left'));
    const bands: Partial<Record<'drHeader' | 'drDetail' | 'drFooter', Band>> = {};
    const get = (t: 'drHeader' | 'drDetail' | 'drFooter') => {
      if (!bands[t]) {
        bands[t] = newBand(t, id, 0);
        bands[t]!.height = 0;
        r.bands.push(bands[t]!);
      }
      return bands[t]!;
    };
    get('drDetail');
    for (const l of c.leaves) {
      const t = l.kind === 'header' || l.kind === 'groupHeader' ? 'drHeader' : l.kind === 'footer' || l.kind === 'groupFooter' ? 'drFooter' : 'drDetail';
      const band = get(t);
      if (t === 'drHeader' && l.repeat) band.repeatEveryPage = true;
      const row = l.row >= 0 ? (rows[l.row] ?? null) : null;
      const h = row ? size(txt(row, 'Height')) : 24;
      this.rowToBand(row, widths, c.hdrWidths, l.hdr, band.id, x0, band.height, h);
      band.height = Math.ceil(band.height + h);
    }
  }

  // ---------------------------------------------------------------- data
  private dataSources(root: Element) {
    for (const ds of kids(kid(root, 'DataSources'), 'DataSource')) {
      const cp = kid(ds, 'ConnectionProperties');
      const name = ds.getAttribute('Name') ?? '';
      if (!cp) this.warn(`Data source "${name}" is a shared data source reference — choose a database connection for it in Report ▸ Data Sources.`);
      this.sources.set(name, { provider: txt(cp, 'DataProvider'), cs: txt(cp, 'ConnectString') });
    }
  }
  private matchConnection(provider: Provider, cs: string): DbConnection | undefined {
    const kv = new Map<string, string>();
    for (const part of cs.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase().replace(/\s+/g, ' '), part.slice(i + 1).trim());
    }
    const server = (kv.get('data source') ?? kv.get('server') ?? kv.get('host') ?? '').toLowerCase();
    const host = server.split(/[\\,:/]/)[0];
    const db = (kv.get('initial catalog') ?? kv.get('database') ?? (server.includes('/') ? server.split('/').pop() : '') ?? '').toLowerCase();
    return this.connections.find((c) => c.provider === provider && (c.host ?? '').toLowerCase() === host && (!db || (c.database ?? '').toLowerCase() === db));
  }
  private dataSets(root: Element) {
    const r = this.r;
    for (const set of kids(kid(root, 'DataSets'), 'DataSet')) {
      const name = set.getAttribute('Name') ?? 'DataSet';
      const id = uid('ds');
      const fieldMap = new Map<string, string>();
      const fields: FieldDef[] = [];
      const calcs: { name: string; value: string }[] = [];
      for (const f of kids(kid(set, 'Fields'), 'Field')) {
        const fname = f.getAttribute('Name') ?? '';
        const df = txt(f, 'DataField');
        const tn = kid(f, 'TypeName')?.textContent ?? '';
        if (df) {
          fieldMap.set(fname.toLowerCase(), df);
          const type: FieldType = /int|decimal|double|single|float|money|numeric/i.test(tn) ? 'number' : /date|time/i.test(tn) ? 'date' : /bool/i.test(tn) ? 'boolean' : 'string';
          fields.push({ name: df, type });
        } else if (txt(f, 'Value')) calcs.push({ name: fname, value: txt(f, 'Value') });
      }
      const info: DsInfo = { id, fields: fieldMap, filter: '' };
      this.sets.set(name, info);
      this.exprCtx = info;
      for (const c of calcs) {
        const e = this.conv(c.value, `Calculated field ${c.name}`);
        if (e && !r.calculatedFields.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) r.calculatedFields.push({ id: uid('c'), name: c.name, expression: e });
        fieldMap.set(c.name.toLowerCase(), c.name);
      }
      info.filter = this.filterOf(set, `Data set ${name} filter`);
      const q = kid(set, 'Query');
      const srcName = txt(q, 'DataSourceName');
      const src = this.sources.get(srcName);
      const text = txt(q, 'CommandText');
      const dp = (src?.provider ?? '').toUpperCase();
      const def: DataSourceDef = { id, name, kind: 'json', content: '[]', fields };
      if (dp === 'XML') {
        def.content = JSON.stringify(xmlRows(text, fields));
        if (!/<XmlData/i.test(text)) this.warn(`Data set "${name}" reads XML from a web address — it was imported empty.`);
      } else if (src || kid(set, 'SharedDataSet')) {
        const provider: Provider = /ORACLE/.test(dp) ? 'oracle' : /postgre/i.test(src?.cs ?? '') ? 'postgres' : /mysql|maria/i.test(src?.cs ?? '') ? 'mysql' : /sqlite/i.test(src?.cs ?? '') ? 'sqlite' : 'mssql';
        const conn = src ? this.matchConnection(provider, src.cs) : undefined;
        const proc = txt(q, 'CommandType') === 'StoredProcedure';
        const parts = text.replace(/[[\]"]/g, '').split('.');
        const params: SqlParam[] = kids(kid(q, 'QueryParameters'), 'QueryParameter').map((p) => ({
          name: (p.getAttribute('Name') ?? '').replace(/^[@:]/, ''),
          type: 'string',
          value: this.conv(txt(p, 'Value'), `Parameter of data set ${name}`) ?? (txt(p, 'Value').startsWith('=') ? '' : `'${txt(p, 'Value').replace(/'/g, "''")}'`),
        }));
        def.kind = 'sql';
        def.content = undefined;
        def.sql = {
          connectionId: conn?.id ?? '',
          connectionName: conn?.name ?? srcName,
          mode: proc ? 'procedure' : 'query',
          ...(proc ? { name: parts.pop(), schema: parts.length ? parts.pop() : undefined, pkg: parts.length && provider === 'oracle' ? parts.pop() : undefined } : { query: text }),
          params,
        };
        if (!conn) this.warn(`Data set "${name}": choose the database connection in Report ▸ Data Sources (RDL connection: ${src?.cs || srcName}).`);
        if (kid(set, 'SharedDataSet')) this.warn(`Data set "${name}" is a shared data set — set its query in Report ▸ Data Sources.`);
      } else this.warn(`Data set "${name}" has no data source — imported empty.`);
      r.dataSources.push(def);
    }
  }

  private parameters(root: Element) {
    for (const p of kids(kid(root, 'ReportParameters'), 'ReportParameter')) {
      const dt = txt(p, 'DataType');
      const dv = txt(at(p, 'DefaultValue', 'Values'), 'Value');
      this.exprCtx = null;
      // ReportTool defaults are values: an expression default (=Year(Today())) is evaluated once
      let defaultValue = dv;
      if (dv.trim().startsWith('=')) {
        const e = this.conv(dv, `Default of parameter ${p.getAttribute('Name')}`);
        const v = e ? evalExpr(e, { row: null, rows: [], params: {} }) : null;
        defaultValue = v === null || v === undefined || (typeof v === 'string' && v.startsWith('#Error')) ? '' : isDate(v) ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v);
        if (e) this.warn(`Parameter "${p.getAttribute('Name')}": the default ${dv} was evaluated once (${defaultValue || 'empty'}).`);
      }
      const def: ParameterDef = {
        id: uid('p'),
        name: p.getAttribute('Name') ?? 'Param',
        label: txt(p, 'Prompt') || (p.getAttribute('Name') ?? ''),
        type: dt === 'Integer' || dt === 'Float' ? 'number' : dt === 'DateTime' ? 'date' : dt === 'Boolean' ? 'boolean' : 'string',
        defaultValue,
        values: kids(at(p, 'ValidValues', 'ParameterValues'), 'ParameterValue')
          .map((v) => txt(v, 'Value'))
          .filter((v) => v && !v.startsWith('='))
          .join(', '),
        visible: txt(p, 'Hidden') !== 'true',
      };
      if (at(p, 'ValidValues', 'DataSetReference')) this.warn(`Parameter "${def.name}" takes its values from a data set — enter the allowed values in Report ▸ Parameters.`);
      this.r.parameters.push(def);
    }
  }

  // ---------------------------------------------------------------- run
  run(): ReportDef {
    const root = this.doc.documentElement;
    const r = this.r;
    r.name = this.fileName.replace(/\.[^.]+$/, '') || 'Report';
    r.description = txt(root, 'Description');
    r.author = txt(root, 'Author');
    r.locale = txt(root, 'Language').startsWith('=') ? 'en-US' : txt(root, 'Language') || 'en-US';
    for (const im of kids(kid(root, 'EmbeddedImages'), 'EmbeddedImage')) this.images.set(im.getAttribute('Name') ?? '', `data:${txt(im, 'MIMEType') || 'image/png'};base64,${txt(im, 'ImageData').replace(/\s+/g, '')}`);
    const section = at(root, 'ReportSections', 'ReportSection') ?? root;
    const page = kid(section, 'Page') ?? kid(root, 'Page') ?? root;
    const body = kid(section, 'Body') ?? kid(root, 'Body');
    if (kids(kid(body, 'ReportItems'), 'Table').length || kids(kid(body, 'ReportItems'), 'List').length || kids(kid(body, 'ReportItems'), 'Matrix').length)
      this.warn('This is an RDL 2005 report (Table / List / Matrix) — open and save it in a newer Report Builder first for a complete import.');
    // page
    const pw = size(txt(page, 'PageWidth')) || 816;
    const ph = size(txt(page, 'PageHeight')) || 1056;
    r.page.width = r.page.baseWidth = Math.round(pw);
    r.page.height = Math.round(ph);
    r.page.margins = {
      top: Math.round(size(txt(page, 'TopMargin'))),
      right: Math.round(size(txt(page, 'RightMargin'))),
      bottom: Math.round(size(txt(page, 'BottomMargin'))),
      left: Math.round(size(txt(page, 'LeftMargin'))),
    };
    const wmm = (pw * 25.4) / 96;
    const hmm = (ph * 25.4) / 96;
    const paper = Object.entries(PAPER_SIZES).find(([, s]) => !s.roll && ((Math.abs(s.w - wmm) < 1.5 && Math.abs(s.h - hmm) < 1.5) || (Math.abs(s.h - wmm) < 1.5 && Math.abs(s.w - hmm) < 1.5)));
    r.page.paper = paper ? paper[0] : 'Custom';
    r.page.orientation = pw > ph ? 'landscape' : 'portrait';
    if (paper) {
      // exact paper size (RDL sizes are rounded)
      const [a, b] = [mmToPx(paper[1].w), mmToPx(paper[1].h)];
      r.page.width = r.page.baseWidth = r.page.orientation === 'landscape' ? Math.max(a, b) : Math.min(a, b);
      r.page.height = r.page.orientation === 'landscape' ? Math.min(a, b) : Math.max(a, b);
    }
    const bodyWidth = size(txt(section, 'Width'));
    if (bodyWidth > pw - r.page.margins.left - r.page.margins.right + 1) {
      r.page.width = Math.round(bodyWidth + r.page.margins.left + r.page.margins.right);
      this.warn('The report body is wider than the page — the page width was increased to fit it.');
    }
    this.parameters(root);
    this.dataSources(root);
    this.dataSets(root);
    // bands
    r.bands = [];
    r.elements = [];
    const rh = newBand('reportHeader', undefined, 0);
    const det = newBand('detail', undefined, 0);
    const rf = newBand('reportFooter', undefined, 0);
    r.bands.push(rh);
    const firstSet = this.sets.values().next().value as DsInfo | undefined;
    const pageBand = (tag: 'PageHeader' | 'PageFooter', type: BandType) => {
      const el = kid(page, tag) ?? kid(root, tag);
      if (!el) return;
      const b = newBand(type, undefined, Math.round(size(txt(el, 'Height'))));
      b.printOnFirstPage = txt(el, 'PrintOnFirstPage') !== 'false';
      b.printOnLastPage = txt(el, 'PrintOnLastPage') !== 'false';
      const bg = this.color(txt(kid(el, 'Style'), 'BackgroundColor'));
      if (bg) b.backColor = bg;
      r.bands.push(b);
      this.exprCtx = firstSet ?? null;
      for (const it of Array.from(kid(el, 'ReportItems')?.children ?? [])) this.item(it, b.id, 0, 0);
    };
    pageBand('PageHeader', 'pageHeader');
    r.bands.push(det, rf);
    pageBand('PageFooter', 'pageFooter');

    // body items with absolute positions (rectangles that only group items are opened up)
    const placed: Placed[] = [];
    const flatten = (items: Element | null, ox: number, oy: number) => {
      for (const it of Array.from(items?.children ?? [])) {
        if (it.localName === 'Rectangle' && kid(it, 'ReportItems')?.querySelector('Tablix')) {
          const st = this.boxStyle(kid(it, 'Style'));
          if (st.backColor || st.borders) this.warn(`Rectangle "${it.getAttribute('Name')}" around a table: its frame was left out.`);
          flatten(kid(it, 'ReportItems'), ox + size(txt(it, 'Left')), oy + size(txt(it, 'Top')));
        } else placed.push({ el: it, x: ox, y: oy });
      }
    };
    flatten(kid(body, 'ReportItems'), 0, 0);
    const isData = (p: Placed) => p.el.localName === 'Tablix' && !!txt(p.el, 'DataSetName') && !this.isMatrix(p.el);
    const top = (p: Placed) => p.y + size(txt(p.el, 'Top'));
    placed.sort((a, b) => top(a) - top(b));
    const tables = placed.filter(isData);
    if (!tables.length) {
      this.exprCtx = firstSet ?? null;
      if (firstSet) r.dataSourceId = firstSet.id;
      for (const p of placed) this.item(p.el, rh.id, p.x, p.y);
      rh.height = Math.ceil(Math.max(20, ...r.elements.filter((e) => e.bandId === rh.id).map((e) => e.y + e.height)));
    } else {
      const main = tables[0];
      const mainTop = top(main);
      const mainSet = this.sets.get(txt(main.el, 'DataSetName')) ?? firstSet!;
      // above the main table -> report header
      this.exprCtx = mainSet;
      for (const p of placed.filter((p) => top(p) < mainTop && !isData(p))) this.item(p.el, rh.id, p.x, p.y);
      rh.height = Math.ceil(Math.max(0, mainTop, ...r.elements.filter((e) => e.bandId === rh.id).map((e) => e.y + e.height)));
      this.mainTablix(main.el, mainSet, rh, rf, mainTop);
      rh.height = Math.ceil(Math.max(rh.height, ...r.elements.filter((e) => e.bandId === rh.id).map((e) => e.y + e.height)));
      // further tables -> sections; other items below -> report footer
      for (const t of tables.slice(1)) {
        const set = this.sets.get(txt(t.el, 'DataSetName'));
        if (set) this.sectionTablix(t.el, set);
      }
      const below = placed.filter((p) => top(p) >= mainTop && !isData(p) && p !== main);
      this.exprCtx = mainSet;
      const footTop = Math.max(0, ...r.elements.filter((e) => e.bandId === rf.id).map((e) => e.y + e.height));
      const minTop = below.length ? Math.min(...below.map(top)) : 0;
      for (const p of below) this.item(p.el, rf.id, p.x, p.y - minTop + footTop);
      rf.height = Math.ceil(Math.max(rf.height, ...r.elements.filter((e) => e.bandId === rf.id).map((e) => e.y + e.height)));
      if (tables.length > 1 && below.length) this.warn('Items below the tables were placed in the Report Footer (after all sections).');
    }
    for (const b of r.bands) b.height = Math.max(0, Math.ceil(b.height));
    // empty report header / footer: keep a small band so they can be used
    if (rh.height === 0) rh.height = 20;
    if (rf.height === 0) rf.height = 20;
    return r;
  }

  private isMatrix(tx: Element): boolean {
    return kids(at(tx, 'TablixColumnHierarchy', 'TablixMembers'), 'TablixMember').some((m) => kid(m, 'Group'));
  }
}

function firstItem(cc: Element | null): Element | null {
  if (!cc) return null;
  return Array.from(cc.children).find((c) => !['ColSpan', 'RowSpan'].includes(c.localName)) ?? null;
}
function validExpr(s: string) {
  try {
    parse(s);
    return true;
  } catch {
    return false;
  }
}
/** rows embedded in an XML data set query (<XmlData>) */
function xmlRows(commandText: string, fields: FieldDef[]): Row[] {
  try {
    const q = new DOMParser().parseFromString(commandText, 'application/xml');
    const data = q.getElementsByTagName('XmlData')[0];
    if (!data) return [];
    const pathText = q.getElementsByTagName('ElementPath')[0]?.textContent ?? '';
    const names = pathText
      .split('/')
      .map((p) => p.replace(/\{.*$/, '').replace(/\(.*$/, '').trim())
      .filter(Boolean);
    let nodes: Element[] = Array.from(data.children);
    if (names.length) {
      nodes = nodes.filter((n) => n.localName === names[0]);
      for (const n of names.slice(1)) nodes = nodes.flatMap((x) => Array.from(x.children).filter((c) => c.localName === n));
    } else nodes = nodes.flatMap((x) => Array.from(x.children));
    const types = new Map(fields.map((f) => [f.name, f.type]));
    return nodes.map((n) => {
      const row: Row = {};
      for (const a of Array.from(n.attributes)) row[a.localName] = a.value;
      for (const c of Array.from(n.children)) if (!c.children.length) row[c.localName] = c.textContent ?? '';
      for (const [k, v] of Object.entries(row)) {
        const t = types.get(k);
        if (t === 'number' && v !== '') row[k] = Number(v);
        else if (t === 'boolean') row[k] = /^(true|1)$/i.test(String(v));
      }
      return row;
    });
  } catch {
    return [];
  }
}

/** Parse an RDL document into a ReportTool report. */
export function importRdl(xml: string, fileName: string, connections: DbConnection[] = []): RdlImportResult {
  const doc = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err || doc.documentElement.localName !== 'Report') throw new Error('Not a valid RDL report file' + (err ? ': ' + (err.textContent ?? '').split('\n')[0] : ''));
  const im = new Importer(doc, fileName, connections);
  const report = im.run();
  return { report, warnings: im.warnings };
}
