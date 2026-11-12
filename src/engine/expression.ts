// Expression language (DevExpress-criteria like):
//   [Field], [Customer.Name], ?Param, [Parameters.Param], 'text', "text", 12.5, #2024-01-31#, True, False, Null
//   + - * / %   = == != <> < <= > >=   And Or Not && || !   x In (a, b, c)
//   Functions: Iif(), Sum(), Format(), Upper(), AddDays(), ...
import type { Row } from '../model/types';
import { compositeFormat, defaultToString, formatValue, isDate, parseDate, type FormatOptions } from './format';

export type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'field'; name: string }
  | { t: 'param'; name: string }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'un'; op: string; e: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'in'; e: Node; list: Node[] };

export interface EvalContext {
  row: Row | null;
  /** rows of the current aggregate scope (group / report / page) */
  rows: Row[];
  params: Record<string, unknown>;
  calc?: Map<string, Node>;
  page?: number;
  pageCount?: number;
  rowIndex?: number; // 0-based index inside the current group
  recordIndex?: number; // 0-based index in the whole report
  reportName?: string;
  fmt?: FormatOptions;
  depth?: number;
}

export class ExprError extends Error {
  pos?: number;
  constructor(msg: string, pos?: number) {
    super(msg);
    this.pos = pos;
  }
}

// ------------------------------------------------------------------ tokenizer
type Tok = { k: 'num' | 'str' | 'date' | 'field' | 'param' | 'id' | 'op' | 'eof'; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.?)/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], pos: start });
      i += m[0].length;
      // allow numeric suffixes like 10m, 10f (DevExpress)
      if (/[mMfFdD]/.test(src[i] ?? '') && !/[A-Za-z0-9_]/.test(src[i + 1] ?? '')) i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let s = '';
      i++;
      while (i < n) {
        if (src[i] === c) {
          if (src[i + 1] === c) {
            s += c;
            i += 2;
            continue;
          }
          break;
        }
        if (src[i] === '\\' && i + 1 < n && c === '"') {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
          continue;
        }
        s += src[i++];
      }
      if (src[i] !== c) throw new ExprError('Unterminated string', start);
      i++;
      out.push({ k: 'str', v: s, pos: start });
      continue;
    }
    if (c === '#') {
      const j = src.indexOf('#', i + 1);
      if (j < 0) throw new ExprError('Unterminated date literal', start);
      out.push({ k: 'date', v: src.slice(i + 1, j), pos: start });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const j = src.indexOf(']', i + 1);
      if (j < 0) throw new ExprError('Missing ]', start);
      out.push({ k: 'field', v: src.slice(i + 1, j).trim(), pos: start });
      i = j + 1;
      continue;
    }
    if (c === '?') {
      const m = /^\?([A-Za-z_\u00C0-\uFFFF][\w\u00C0-\uFFFF]*)/.exec(src.slice(i));
      if (!m) throw new ExprError('Invalid parameter name', start);
      out.push({ k: 'param', v: m[1], pos: start });
      i += m[0].length;
      continue;
    }
    const idm = /^[A-Za-z_\u00C0-\uFFFF][\w\u00C0-\uFFFF]*/.exec(src.slice(i));
    if (idm) {
      out.push({ k: 'id', v: idm[0], pos: start });
      i += idm[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<>', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/%=<>!(),'.includes(c)) {
      out.push({ k: 'op', v: c, pos: start });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}'`, start);
  }
  out.push({ k: 'eof', v: '', pos: n });
  return out;
}

// ------------------------------------------------------------------ parser
class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek() {
    return this.toks[this.i];
  }
  next() {
    return this.toks[this.i++];
  }
  isOp(v: string) {
    const t = this.peek();
    return t.k === 'op' && t.v === v;
  }
  isKw(v: string) {
    const t = this.peek();
    return t.k === 'id' && t.v.toLowerCase() === v;
  }
  expect(v: string) {
    const t = this.next();
    if (t.k !== 'op' || t.v !== v) throw new ExprError(`Expected '${v}'`, t.pos);
  }
  parse(): Node {
    const e = this.or();
    const t = this.peek();
    if (t.k !== 'eof') throw new ExprError(`Unexpected '${t.v}'`, t.pos);
    return e;
  }
  or(): Node {
    let l = this.and();
    while (this.isOp('||') || this.isKw('or')) {
      this.next();
      l = { t: 'bin', op: 'or', l, r: this.and() };
    }
    return l;
  }
  and(): Node {
    let l = this.not();
    while (this.isOp('&&') || this.isKw('and')) {
      this.next();
      l = { t: 'bin', op: 'and', l, r: this.not() };
    }
    return l;
  }
  not(): Node {
    if (this.isOp('!') || this.isKw('not')) {
      this.next();
      return { t: 'un', op: 'not', e: this.not() };
    }
    return this.cmp();
  }
  cmp(): Node {
    const l = this.add();
    const t = this.peek();
    if (t.k === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
      this.next();
      const op = t.v === '==' ? '=' : t.v === '<>' ? '!=' : t.v;
      return { t: 'bin', op, l, r: this.add() };
    }
    if (this.isKw('in')) {
      this.next();
      this.expect('(');
      const list = this.args();
      return { t: 'in', e: l, list };
    }
    if (this.isKw('like')) {
      this.next();
      return { t: 'call', name: 'like', args: [l, this.add()] };
    }
    if (this.isKw('between')) {
      this.next();
      this.expect('(');
      const a = this.args();
      return { t: 'call', name: 'between', args: [l, ...a] };
    }
    return l;
  }
  add(): Node {
    let l = this.mul();
    for (;;) {
      if (this.isOp('+') || this.isOp('-')) {
        const op = this.next().v;
        l = { t: 'bin', op, l, r: this.mul() };
      } else return l;
    }
  }
  mul(): Node {
    let l = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next().v;
        l = { t: 'bin', op, l, r: this.unary() };
      } else return l;
    }
  }
  unary(): Node {
    if (this.isOp('-')) {
      this.next();
      return { t: 'un', op: '-', e: this.unary() };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.primary();
  }
  args(): Node[] {
    const out: Node[] = [];
    if (this.isOp(')')) {
      this.next();
      return out;
    }
    for (;;) {
      out.push(this.or());
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      this.expect(')');
      return out;
    }
  }
  primary(): Node {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'lit', v: Number(t.v) };
      case 'str':
        return { t: 'lit', v: t.v };
      case 'date': {
        const d = parseDate(t.v);
        if (!d) throw new ExprError('Invalid date literal', t.pos);
        return { t: 'lit', v: d };
      }
      case 'field': {
        if (/^parameters\./i.test(t.v)) return { t: 'param', name: t.v.slice(11) };
        return { t: 'field', name: t.v };
      }
      case 'param':
        return { t: 'param', name: t.v };
      case 'id': {
        const lw = t.v.toLowerCase();
        if (this.isOp('(')) {
          this.next();
          const args = this.args();
          if (!FUNCS[lw]) throw new ExprError(`Unknown function '${t.v}'`, t.pos);
          return { t: 'call', name: lw, args };
        }
        if (lw === 'true') return { t: 'lit', v: true };
        if (lw === 'false') return { t: 'lit', v: false };
        if (lw === 'null') return { t: 'lit', v: null };
        // bare identifiers are treated as field names for convenience
        return { t: 'field', name: t.v };
      }
      case 'op':
        if (t.v === '(') {
          const e = this.or();
          this.expect(')');
          return e;
        }
        throw new ExprError(`Unexpected '${t.v}'`, t.pos);
      default:
        throw new ExprError('Unexpected end of expression', t.pos);
    }
  }
}

const cache = new Map<string, Node | ExprError>();
export function parse(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    try {
      n = new Parser(tokenize(src)).parse();
    } catch (e) {
      n = e instanceof ExprError ? e : new ExprError(String(e));
    }
    if (cache.size > 5000) cache.clear();
    cache.set(src, n);
  }
  if (n instanceof ExprError) throw n;
  return n;
}

export function validate(src: string): string | null {
  if (!src.trim()) return null;
  try {
    parse(src);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ------------------------------------------------------------------ helpers
export const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isDate(v)) return v.getTime();
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};
export const truthy = (v: unknown): boolean => {
  if (typeof v === 'string') return v !== '' && v.toLowerCase() !== 'false' && v !== '0';
  return !!v;
};
const isNumLike = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));

export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '' ? 0 : -1;
  if (b === null || b === undefined || b === '') return 1;
  if (isDate(a) || isDate(b)) {
    const da = parseDate(a);
    const db = parseDate(b);
    if (da && db) return da.getTime() - db.getTime();
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return toNum(a) - toNum(b);
  if (isNumLike(a) && isNumLike(b)) return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
const eq = (a: unknown, b: unknown) => {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return compareValues(a, b) === 0;
};

function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function getField(ctx: EvalContext, name: string): unknown {
  const row = ctx.row;
  if (row) {
    if (name in row) return row[name];
    if (name.includes('.')) {
      const v = getPath(row, name);
      if (v !== undefined) return v;
    }
  }
  const calc = ctx.calc?.get(name.toLowerCase());
  if (calc) {
    const depth = (ctx.depth ?? 0) + 1;
    if (depth > 20) throw new ExprError('Calculated field recursion');
    return evaluate(calc, { ...ctx, depth });
  }
  if (row) {
    const lname = name.toLowerCase();
    for (const k of Object.keys(row)) if (k.toLowerCase() === lname) return row[k];
  }
  return null;
}

const addMonths = (d: Date, n: number) => {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + n);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, last));
  return r;
};
const dateArg = (v: unknown) => parseDate(v);
const str = (v: unknown, ctx: EvalContext) => defaultToString(v, ctx.fmt);

function aggregate(fn: string, args: Node[], ctx: EvalContext): unknown {
  const rows = ctx.rows ?? [];
  const vals: unknown[] = [];
  if (args.length === 0) {
    if (fn === 'count') return rows.length;
  }
  for (const row of rows) {
    const v = args.length ? evaluate(args[0], { ...ctx, row }) : 1;
    vals.push(v);
  }
  return aggregateValues(fn, vals);
}

export function aggregateValues(fn: string, vals: unknown[]): unknown {
  const nonNull = vals.filter((v) => v !== null && v !== undefined && v !== '');
  switch (fn) {
    case 'sum':
      return nonNull.reduce<number>((s, v) => s + toNum(v), 0);
    case 'count':
      return nonNull.length;
    case 'avg':
      return nonNull.length ? nonNull.reduce<number>((s, v) => s + toNum(v), 0) / nonNull.length : null;
    case 'min':
      return nonNull.length ? nonNull.reduce((m, v) => (compareValues(v, m) < 0 ? v : m)) : null;
    case 'max':
      return nonNull.length ? nonNull.reduce((m, v) => (compareValues(v, m) > 0 ? v : m)) : null;
    case 'countdistinct': {
      const s = new Set(nonNull.map((v) => (isDate(v) ? v.getTime() : v)));
      return s.size;
    }
    case 'first':
      return vals.length ? vals[0] : null;
    case 'last':
      return vals.length ? vals[vals.length - 1] : null;
  }
  return null;
}

type Fn = (args: Node[], ctx: EvalContext) => unknown;
interface FnInfo {
  cat: string;
  sig: string;
  desc: string;
  fn: Fn;
}

const ev = (n: Node, ctx: EvalContext) => evaluate(n, ctx);
const evs = (args: Node[], ctx: EvalContext) => args.map((a) => evaluate(a, ctx));
const f1 = (fn: (a: any, ctx: EvalContext) => unknown): Fn => (args, ctx) => fn(ev(args[0], ctx), ctx);
const fn = (fnc: (vals: any[], ctx: EvalContext) => unknown): Fn => (args, ctx) => fnc(evs(args, ctx), ctx);

const agg = (name: string): Fn => (args, ctx) => aggregate(name, args, ctx);

export const FUNCS: Record<string, FnInfo> = {
  // ---- logical
  iif: {
    cat: 'Logical',
    sig: 'Iif(condition, trueValue, falseValue)',
    desc: 'Returns trueValue when condition is true. Accepts more pairs: Iif(c1, v1, c2, v2, else)',
    fn: (args, ctx) => {
      let i = 0;
      for (; i + 1 < args.length; i += 2) if (truthy(ev(args[i], ctx))) return ev(args[i + 1], ctx);
      return i < args.length ? ev(args[i], ctx) : null;
    },
  },
  isnull: {
    cat: 'Logical',
    sig: 'IsNull(value[, default])',
    desc: 'With one argument returns true if value is null. With two returns default when value is null.',
    fn: (args, ctx) => {
      const v = ev(args[0], ctx);
      if (args.length < 2) return v === null || v === undefined;
      return v === null || v === undefined ? ev(args[1], ctx) : v;
    },
  },
  isnullorempty: { cat: 'Logical', sig: 'IsNullOrEmpty(value)', desc: 'True if the value is null or an empty string', fn: f1((v) => v === null || v === undefined || v === '') },
  coalesce: {
    cat: 'Logical',
    sig: 'Coalesce(a, b, ...)',
    desc: 'First non-null argument',
    fn: (args, ctx) => {
      for (const a of args) {
        const v = ev(a, ctx);
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    },
  },
  between: { cat: 'Logical', sig: 'Between(value, from, to)', desc: 'True when from <= value <= to', fn: fn(([v, a, b]) => compareValues(v, a) >= 0 && compareValues(v, b) <= 0) },
  like: {
    cat: 'Logical',
    sig: "Like(value, 'pattern%')",
    desc: 'SQL LIKE match: % any characters, _ one character',
    fn: fn(([v, p], ctx) => {
      const re = new RegExp('^' + String(p ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
      return re.test(str(v, ctx));
    }),
  },
  // ---- aggregates
  sum: { cat: 'Aggregate', sig: 'Sum([Field])', desc: 'Sum over the current scope (group, report or page)', fn: agg('sum') },
  count: { cat: 'Aggregate', sig: 'Count()', desc: 'Number of rows in the current scope', fn: agg('count') },
  avg: { cat: 'Aggregate', sig: 'Avg([Field])', desc: 'Average over the current scope', fn: agg('avg') },
  min: {
    cat: 'Aggregate',
    sig: 'Min([Field]) | Min(a, b)',
    desc: 'Minimum over the scope (1 argument) or of the arguments',
    fn: (args, ctx) => (args.length === 1 ? aggregate('min', args, ctx) : evs(args, ctx).reduce((m, v) => (compareValues(v, m) < 0 ? v : m))),
  },
  max: {
    cat: 'Aggregate',
    sig: 'Max([Field]) | Max(a, b)',
    desc: 'Maximum over the scope (1 argument) or of the arguments',
    fn: (args, ctx) => (args.length === 1 ? aggregate('max', args, ctx) : evs(args, ctx).reduce((m, v) => (compareValues(v, m) > 0 ? v : m))),
  },
  countdistinct: { cat: 'Aggregate', sig: 'CountDistinct([Field])', desc: 'Number of distinct values in the scope', fn: agg('countdistinct') },
  first: { cat: 'Aggregate', sig: 'First([Field])', desc: 'Value from the first row in scope', fn: agg('first') },
  last: { cat: 'Aggregate', sig: 'Last([Field])', desc: 'Value from the last row in scope', fn: agg('last') },
  // ---- math
  abs: { cat: 'Math', sig: 'Abs(x)', desc: 'Absolute value', fn: f1((v) => Math.abs(toNum(v))) },
  round: {
    cat: 'Math',
    sig: 'Round(x[, digits])',
    desc: 'Round to the given number of decimals',
    fn: fn(([v, d]) => {
      const p = Math.pow(10, toNum(d ?? 0));
      return Math.round(toNum(v) * p + Number.EPSILON) / p;
    }),
  },
  floor: { cat: 'Math', sig: 'Floor(x)', desc: 'Largest integer <= x', fn: f1((v) => Math.floor(toNum(v))) },
  ceiling: { cat: 'Math', sig: 'Ceiling(x)', desc: 'Smallest integer >= x', fn: f1((v) => Math.ceil(toNum(v))) },
  truncate: { cat: 'Math', sig: 'Truncate(x)', desc: 'Integer part of x', fn: f1((v) => Math.trunc(toNum(v))) },
  sqrt: { cat: 'Math', sig: 'Sqrt(x)', desc: 'Square root', fn: f1((v) => Math.sqrt(toNum(v))) },
  power: { cat: 'Math', sig: 'Power(x, y)', desc: 'x raised to y', fn: fn(([a, b]) => Math.pow(toNum(a), toNum(b))) },
  exp: { cat: 'Math', sig: 'Exp(x)', desc: 'e raised to x', fn: f1((v) => Math.exp(toNum(v))) },
  log: { cat: 'Math', sig: 'Log(x[, base])', desc: 'Logarithm', fn: fn(([a, b]) => (b === undefined ? Math.log(toNum(a)) : Math.log(toNum(a)) / Math.log(toNum(b)))) },
  log10: { cat: 'Math', sig: 'Log10(x)', desc: 'Base 10 logarithm', fn: f1((v) => Math.log10(toNum(v))) },
  sign: { cat: 'Math', sig: 'Sign(x)', desc: '-1, 0 or 1', fn: f1((v) => Math.sign(toNum(v))) },
  mod: { cat: 'Math', sig: 'Mod(a, b)', desc: 'Remainder of a / b', fn: fn(([a, b]) => toNum(a) % toNum(b)) },
  rnd: { cat: 'Math', sig: 'Rnd()', desc: 'Random number 0..1', fn: () => Math.random() },
  // ---- string
  len: { cat: 'String', sig: 'Len(s)', desc: 'Length of a string', fn: f1((v, c) => str(v, c).length) },
  upper: { cat: 'String', sig: 'Upper(s)', desc: 'Upper case', fn: f1((v, c) => str(v, c).toUpperCase()) },
  lower: { cat: 'String', sig: 'Lower(s)', desc: 'Lower case', fn: f1((v, c) => str(v, c).toLowerCase()) },
  trim: { cat: 'String', sig: 'Trim(s)', desc: 'Remove leading/trailing spaces', fn: f1((v, c) => str(v, c).trim()) },
  substring: {
    cat: 'String',
    sig: 'Substring(s, start[, length])',
    desc: 'Part of a string (start is 0-based)',
    fn: fn(([s, a, l], c) => {
      const t = str(s, c);
      return l === undefined ? t.substr(toNum(a)) : t.substr(toNum(a), toNum(l));
    }),
  },
  left: { cat: 'String', sig: 'Left(s, n)', desc: 'First n characters', fn: fn(([s, n], c) => str(s, c).slice(0, toNum(n))) },
  right: { cat: 'String', sig: 'Right(s, n)', desc: 'Last n characters', fn: fn(([s, n], c) => (toNum(n) <= 0 ? '' : str(s, c).slice(-toNum(n)))) },
  replace: { cat: 'String', sig: 'Replace(s, find, replacement)', desc: 'Replace all occurrences', fn: fn(([s, a, b], c) => str(s, c).split(str(a, c)).join(str(b, c))) },
  contains: { cat: 'String', sig: 'Contains(s, sub)', desc: 'True if s contains sub (case-insensitive)', fn: fn(([s, a], c) => str(s, c).toLowerCase().includes(str(a, c).toLowerCase())) },
  startswith: { cat: 'String', sig: 'StartsWith(s, prefix)', desc: 'True if s starts with prefix', fn: fn(([s, a], c) => str(s, c).toLowerCase().startsWith(str(a, c).toLowerCase())) },
  endswith: { cat: 'String', sig: 'EndsWith(s, suffix)', desc: 'True if s ends with suffix', fn: fn(([s, a], c) => str(s, c).toLowerCase().endsWith(str(a, c).toLowerCase())) },
  indexof: { cat: 'String', sig: 'IndexOf(s, sub)', desc: '0-based position of sub or -1', fn: fn(([s, a], c) => str(s, c).indexOf(str(a, c))) },
  padleft: { cat: 'String', sig: "PadLeft(s, length[, char])", desc: 'Pad on the left', fn: fn(([s, n, ch], c) => str(s, c).padStart(toNum(n), ch ? str(ch, c) : ' ')) },
  padright: { cat: 'String', sig: "PadRight(s, length[, char])", desc: 'Pad on the right', fn: fn(([s, n, ch], c) => str(s, c).padEnd(toNum(n), ch ? str(ch, c) : ' ')) },
  concat: { cat: 'String', sig: 'Concat(a, b, ...)', desc: 'Join values as text', fn: fn((vals, c) => vals.map((v) => str(v, c)).join('')) },
  reverse: { cat: 'String', sig: 'Reverse(s)', desc: 'Reverse a string', fn: f1((v, c) => Array.from(str(v, c)).reverse().join('')) },
  tostr: { cat: 'Conversion', sig: 'ToStr(value)', desc: 'Convert to text', fn: f1((v, c) => str(v, c)) },
  format: {
    cat: 'String',
    sig: "Format(value, 'n2')",
    desc: "Format a value: 'n2', 'c', 'p0', 'yyyy-MM-dd', or composite '{0:c} of {1}'",
    fn: fn(([v, f, ...rest], c) => {
      const fs = str(f, c);
      if (fs.includes('{0')) return compositeFormat(fs, [v, ...rest], c.fmt);
      return formatValue(v, fs, c.fmt);
    }),
  },
  // ---- dates
  now: { cat: 'Date', sig: 'Now()', desc: 'Current date and time', fn: () => new Date() },
  today: {
    cat: 'Date',
    sig: 'Today()',
    desc: 'Current date (no time)',
    fn: () => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    },
  },
  datetime: { cat: 'Date', sig: 'DateTime(year, month, day)', desc: 'Create a date', fn: fn(([y, m, d]) => new Date(toNum(y), toNum(m) - 1, toNum(d ?? 1))) },
  todate: { cat: 'Conversion', sig: 'ToDate(value)', desc: 'Convert to date', fn: f1((v) => parseDate(v)) },
  year: { cat: 'Date', sig: 'Year(date)', desc: 'Year part', fn: f1((v) => dateArg(v)?.getFullYear() ?? null) },
  month: { cat: 'Date', sig: 'Month(date)', desc: 'Month part (1-12)', fn: f1((v) => (dateArg(v) ? dateArg(v)!.getMonth() + 1 : null)) },
  day: { cat: 'Date', sig: 'Day(date)', desc: 'Day of month', fn: f1((v) => dateArg(v)?.getDate() ?? null) },
  hour: { cat: 'Date', sig: 'Hour(date)', desc: 'Hour part', fn: f1((v) => dateArg(v)?.getHours() ?? null) },
  minute: { cat: 'Date', sig: 'Minute(date)', desc: 'Minute part', fn: f1((v) => dateArg(v)?.getMinutes() ?? null) },
  second: { cat: 'Date', sig: 'Second(date)', desc: 'Second part', fn: f1((v) => dateArg(v)?.getSeconds() ?? null) },
  dayofweek: { cat: 'Date', sig: 'DayOfWeek(date)', desc: '0 = Sunday ... 6 = Saturday', fn: f1((v) => dateArg(v)?.getDay() ?? null) },
  dayofyear: {
    cat: 'Date',
    sig: 'DayOfYear(date)',
    desc: 'Day number in the year',
    fn: f1((v) => {
      const d = dateArg(v);
      if (!d) return null;
      return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86400000) + 1;
    }),
  },
  quarter: { cat: 'Date', sig: 'Quarter(date)', desc: 'Quarter 1-4', fn: f1((v) => (dateArg(v) ? Math.floor(dateArg(v)!.getMonth() / 3) + 1 : null)) },
  adddays: { cat: 'Date', sig: 'AddDays(date, n)', desc: 'Add days', fn: fn(([d, n]) => (dateArg(d) ? new Date(dateArg(d)!.getTime() + toNum(n) * 86400000) : null)) },
  addhours: { cat: 'Date', sig: 'AddHours(date, n)', desc: 'Add hours', fn: fn(([d, n]) => (dateArg(d) ? new Date(dateArg(d)!.getTime() + toNum(n) * 3600000) : null)) },
  addminutes: { cat: 'Date', sig: 'AddMinutes(date, n)', desc: 'Add minutes', fn: fn(([d, n]) => (dateArg(d) ? new Date(dateArg(d)!.getTime() + toNum(n) * 60000) : null)) },
  addmonths: { cat: 'Date', sig: 'AddMonths(date, n)', desc: 'Add months', fn: fn(([d, n]) => (dateArg(d) ? addMonths(dateArg(d)!, toNum(n)) : null)) },
  addyears: { cat: 'Date', sig: 'AddYears(date, n)', desc: 'Add years', fn: fn(([d, n]) => (dateArg(d) ? addMonths(dateArg(d)!, toNum(n) * 12) : null)) },
  datediffday: {
    cat: 'Date',
    sig: 'DateDiffDay(start, end)',
    desc: 'Number of day boundaries between two dates',
    fn: fn(([a, b]) => {
      const x = dateArg(a);
      const y = dateArg(b);
      if (!x || !y) return null;
      return Math.round((Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()) - Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 86400000);
    }),
  },
  datediffmonth: {
    cat: 'Date',
    sig: 'DateDiffMonth(start, end)',
    desc: 'Number of month boundaries between two dates',
    fn: fn(([a, b]) => {
      const x = dateArg(a);
      const y = dateArg(b);
      if (!x || !y) return null;
      return (y.getFullYear() - x.getFullYear()) * 12 + y.getMonth() - x.getMonth();
    }),
  },
  datediffyear: {
    cat: 'Date',
    sig: 'DateDiffYear(start, end)',
    desc: 'Number of year boundaries between two dates',
    fn: fn(([a, b]) => {
      const x = dateArg(a);
      const y = dateArg(b);
      return x && y ? y.getFullYear() - x.getFullYear() : null;
    }),
  },
  // ---- conversion
  toint: { cat: 'Conversion', sig: 'ToInt(value)', desc: 'Convert to integer', fn: f1((v) => Math.trunc(toNum(v))) },
  todouble: { cat: 'Conversion', sig: 'ToDouble(value)', desc: 'Convert to number', fn: f1((v) => toNum(v)) },
  todecimal: { cat: 'Conversion', sig: 'ToDecimal(value)', desc: 'Convert to number', fn: f1((v) => toNum(v)) },
  tobool: { cat: 'Conversion', sig: 'ToBool(value)', desc: 'Convert to boolean', fn: f1((v) => truthy(v)) },
  // ---- report
  pagenumber: { cat: 'Report', sig: 'PageNumber()', desc: 'Current page number', fn: (_a, ctx) => ctx.page ?? 1 },
  pagecount: { cat: 'Report', sig: 'PageCount()', desc: 'Total number of pages', fn: (_a, ctx) => ctx.pageCount ?? 1 },
  rownumber: { cat: 'Report', sig: 'RowNumber()', desc: 'Row number inside the current group (1-based)', fn: (_a, ctx) => (ctx.rowIndex ?? 0) + 1 },
  recordnumber: { cat: 'Report', sig: 'RecordNumber()', desc: 'Row number in the whole report (1-based)', fn: (_a, ctx) => (ctx.recordIndex ?? 0) + 1 },
  reportname: { cat: 'Report', sig: 'ReportName()', desc: 'Name of the report', fn: (_a, ctx) => ctx.reportName ?? '' },
};

export function evaluate(node: Node, ctx: EvalContext): unknown {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'field':
      return getField(ctx, node.name);
    case 'param': {
      const p = ctx.params;
      if (node.name in p) return p[node.name];
      const k = Object.keys(p).find((x) => x.toLowerCase() === node.name.toLowerCase());
      return k ? p[k] : null;
    }
    case 'un': {
      const v = evaluate(node.e, ctx);
      if (node.op === 'not') return !truthy(v);
      if (v === null || v === undefined) return null;
      return -toNum(v);
    }
    case 'in': {
      const v = evaluate(node.e, ctx);
      return node.list.some((n) => eq(v, evaluate(n, ctx)));
    }
    case 'call':
      return FUNCS[node.name].fn(node.args, ctx);
    case 'bin': {
      if (node.op === 'and') return truthy(evaluate(node.l, ctx)) && truthy(evaluate(node.r, ctx));
      if (node.op === 'or') return truthy(evaluate(node.l, ctx)) || truthy(evaluate(node.r, ctx));
      const a = evaluate(node.l, ctx);
      const b = evaluate(node.r, ctx);
      switch (node.op) {
        case '+':
          if (isDate(a) && typeof b === 'number') return new Date(a.getTime() + b * 86400000);
          if (typeof a === 'string' || typeof b === 'string' || isDate(a) || isDate(b)) return str(a, ctx) + str(b, ctx);
          if (a === null || a === undefined || b === null || b === undefined) return null;
          return toNum(a) + toNum(b);
        case '-':
          if (isDate(a) && isDate(b)) return (a.getTime() - b.getTime()) / 86400000;
          if (isDate(a) && typeof b === 'number') return new Date(a.getTime() - b * 86400000);
          if (a === null || a === undefined || b === null || b === undefined) return null;
          return toNum(a) - toNum(b);
        case '*':
          if (a === null || a === undefined || b === null || b === undefined) return null;
          return toNum(a) * toNum(b);
        case '/': {
          if (a === null || a === undefined || b === null || b === undefined) return null;
          const d = toNum(b);
          return d === 0 ? null : toNum(a) / d;
        }
        case '%': {
          const d = toNum(b);
          return d === 0 ? null : toNum(a) % d;
        }
        case '=':
          return eq(a, b);
        case '!=':
          return !eq(a, b);
        case '<':
          return compareValues(a, b) < 0;
        case '<=':
          return compareValues(a, b) <= 0;
        case '>':
          return compareValues(a, b) > 0;
        case '>=':
          return compareValues(a, b) >= 0;
      }
    }
  }
  return null;
}

/** Evaluate an expression string; errors are returned as '#Error' text. */
export function evalExpr(src: string, ctx: EvalContext): unknown {
  if (!src || !src.trim()) return null;
  try {
    return evaluate(parse(src), ctx);
  } catch (e) {
    return '#Error: ' + (e as Error).message;
  }
}

/** Interpolate "{expr}" blocks inside static text. "{{" and "}}" escape braces. */
export function interpolate(text: string, ctx: EvalContext): string {
  if (!text || !text.includes('{')) return text ?? '';
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{' && text[i + 1] === '{') {
      out += '{';
      i += 2;
      continue;
    }
    if (c === '}' && text[i + 1] === '}') {
      out += '}';
      i += 2;
      continue;
    }
    if (c === '{') {
      // find matching close brace, skipping quoted strings
      let j = i + 1;
      let q = '';
      let depth = 1;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (q) {
          if (ch === q) q = '';
          continue;
        }
        if (ch === "'" || ch === '"') q = ch;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) break;
      }
      if (j >= text.length) {
        out += text.slice(i);
        break;
      }
      const expr = text.slice(i + 1, j);
      out += defaultToString(evalExpr(expr, ctx), ctx.fmt);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Does this expression (or interpolated text) use PageNumber()/PageCount()? */
export function usesPageInfo(src: string): boolean {
  return !!src && /\bpage(number|count)\s*\(/i.test(src);
}

/** Collect field names referenced by an expression. */
export function referencedFields(src: string): string[] {
  try {
    const out = new Set<string>();
    const walk = (n: Node) => {
      if (n.t === 'field') out.add(n.name);
      else if (n.t === 'bin') {
        walk(n.l);
        walk(n.r);
      } else if (n.t === 'un') walk(n.e);
      else if (n.t === 'call') n.args.forEach(walk);
      else if (n.t === 'in') {
        walk(n.e);
        n.list.forEach(walk);
      }
    };
    walk(parse(src));
    return [...out];
  } catch {
    return [];
  }
}

export const FUNCTION_LIST = Object.entries(FUNCS).map(([name, f]) => ({ name, cat: f.cat, sig: f.sig, desc: f.desc }));
