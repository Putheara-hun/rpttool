// Report definition -> RDL (Report Definition Language, 2010 schema): SQL Server Reporting Services 2008 R2 … 2022,
// Report Builder, Power BI Report Builder and Visual Studio report projects.
//
// Mapping:
//   Report Header / Footer           -> rectangles in the body (aggregates scoped to the main data set)
//   Groups + Detail                  -> one list tablix: group members with header/footer rows, a Details group
//   Detail Report "once" sections     -> further list tablixes below the main list (own data set + filter)
//   Detail Report "per row" sections  -> subreports (extra .rdl files) linked by key / [Master.X] parameters
//   Page Header / Footer             -> page header / footer (fields read the first row of the main data set)
//   Expressions                      -> VB.NET expressions (Fields!X.Value, Parameters!P.Value, Sum(…), IIf(…))
//   Database sources                 -> data sources + data sets (connection string without credentials)
//   JSON / CSV / sample data          -> XML data provider with the rows embedded in the query
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import type {
  Band,
  ChartElement,
  CrosstabElement,
  DataSourceDef,
  DetailReportDef,
  FieldType,
  ImageElement,
  ParameterDef,
  ReportDef,
  ReportElement,
  ResolvedStyle,
  Row,
  SqlSource,
  StyleProps,
  SummaryFunc,
  SummaryRunning,
} from '../model/types';
import { childDetailReports, contentWidth, resolveStyle } from '../model/defaults';
import { cellOwners, cellRectOf } from '../model/table';
import { parse, referencedFields, type Node } from '../engine/expression';
import { isDate } from '../engine/format';
import { layoutElement, type LayoutEnv } from '../engine/layout';
import { inferFields } from '../data/dataSource';
import { isGoogleFont, usedFamilies } from '../engine/fonts';
import type { DbConnection } from '../data/dbApi';
import { primsToSvg, watermarkSvg } from './svg';
import { normColor, svgToCanvas, toDataUrl } from './raster';

export const RDL_NS = 'http://schemas.microsoft.com/sqlserver/reporting/2010/01/reportdefinition';
const RD_NS = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';
export const RT_NS = 'urn:reporttool:definition';

export interface RdlOptions {
  /** file name without extension; subreports are named <baseName>_<Section>.rdl */
  baseName: string;
  /** loaded rows of a data source (embedded for JSON / CSV / sample / web sources) */
  rows: (dsId: string) => Row[];
  /** saved database connections (no passwords) used to build connection strings */
  connections: DbConnection[];
  maxEmbeddedRows?: number;
  /** store the ReportTool design inside the RDL so ReportTool can reopen it without loss */
  embedDefinition?: boolean;
}
export interface RdlFile {
  name: string;
  xml: string;
}
export interface RdlResult {
  files: RdlFile[];
  warnings: string[];
}

// ------------------------------------------------------------------ xml helpers
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
export const xesc = (s: string) => s.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** <name>text</name>, omitted when the value is empty */
const T = (name: string, v: string | number | boolean | null | undefined) => (v === undefined || v === null || v === '' ? '' : `<${name}>${xesc(String(v))}</${name}>`);
/** <name>text</name>, always written */
const TE = (name: string, v: string) => `<${name}>${xesc(v)}</${name}>`;
const E = (name: string, inner: string, attrs: Record<string, string> = {}) =>
  `<${name}${Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${xesc(v)}"`)
    .join('')}>${inner}</${name}>`;
const EN = (name: string, nameAttr: string, inner: string) => E(name, inner, { Name: nameAttr });
const NO_BORDER = E('Border', T('Style', 'None'));

const r2 = (v: number) => Math.round(v * 100) / 100;
const mm = (px: number) => `${r2((px * 25.4) / 96)}mm`;
const pt = (px: number) => `${r2(px * 0.75)}pt`;
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const color = (c?: string | null) => (c ? (normColor(c)?.hex ?? null) : null);

/** A CLS identifier (letters, digits, underscore; starts with a letter) as required for RDL names. */
export function ident(s: string, fallback = 'Item') {
  let x = (s || '')
    .normalize('NFKD')
    .replace(/[^\w]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!x) x = fallback;
  if (!/^[A-Za-z]/.test(x)) x = fallback + '_' + x;
  return x.slice(0, 100);
}

/** VB string literal ("" escaping, line breaks as vbCrLf). */
export function vbStr(s: string) {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((p) => '"' + p.replace(/"/g, '""') + '"')
    .join(' & vbCrLf & ');
}

/** Indent compact XML (one element per line, leaf elements on one line). */
export function prettyXml(xml: string): string {
  const toks = xml.match(/<[^>]+>|[^<]+/g) ?? [];
  const out: string[] = [];
  let depth = 0;
  const ind = () => '  '.repeat(Math.max(0, depth));
  for (let i = 0; i < toks.length; ) {
    const t = toks[i];
    if (t.startsWith('<?')) {
      out.push(t);
      i++;
    } else if (t.startsWith('</')) {
      depth--;
      out.push(ind() + t);
      i++;
    } else if (t.startsWith('<')) {
      if (t.endsWith('/>')) {
        out.push(ind() + t);
        i++;
        continue;
      }
      const a = toks[i + 1];
      const b = toks[i + 2];
      if (a !== undefined && !a.startsWith('<') && b?.startsWith('</')) {
        out.push(ind() + t + a + b);
        i += 3;
      } else if (a?.startsWith('</')) {
        out.push(ind() + t + a);
        i += 2;
      } else {
        out.push(ind() + t);
        depth++;
        i++;
      }
    } else {
      if (out.length) out[out.length - 1] += t;
      i++;
    }
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ embedded ReportTool design
function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function b64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s.replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
/** Append the (compressed) ReportTool design + a hash of the RDL text, so changes made elsewhere can be detected. */
export function embedDefinition(xml: string, def: ReportDef): string {
  const core = xml.replace(/\r\n?/g, '\n');
  const data = b64(deflateSync(strToU8(JSON.stringify(def))));
  const tag = `  <rt:ReportTool xmlns:rt="${RT_NS}" rt:version="1" rt:hash="${fnv(core)}">${data}</rt:ReportTool>\n`;
  const i = core.lastIndexOf('</Report>');
  return i < 0 ? core : core.slice(0, i) + tag + core.slice(i);
}
/** The ReportTool design stored in an RDL file; modified = the RDL was changed by another tool since. */
export function extractDefinition(xml: string): { def: ReportDef; modified: boolean } | null {
  const text = xml.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /[ \t]*<rt:ReportTool\b[^>]*?\b(?:rt:)?hash="([0-9a-f]+)"[^>]*>([\s\S]*?)<\/rt:ReportTool>\n?/.exec(text);
  if (!m) return null;
  try {
    const def = JSON.parse(strFromU8(inflateSync(unb64(m[2].trim())))) as ReportDef;
    const core = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    return { def, modified: fnv(core) !== m[1] };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ expressions -> VB
interface FieldInfo {
  rdl: string;
  type: FieldType | 'any';
  /** column / attribute name in the query result (absent for calculated fields) */
  dataField?: string;
  /** original field name (dotted paths for nested JSON) */
  source?: string;
  calc?: string;
}
type FieldMap = Map<string, FieldInfo>;

interface Scope {
  fields: FieldMap | null;
  /** scope name for aggregates (data set / data region / group); null = the containing scope */
  agg: string | null;
  /** wrap field references that are not inside an aggregate (needed outside a data region) */
  bare: { fn: 'First' | 'Last'; scope: string | null } | null;
  rowScope: string | null;
  run: { report: string | null; group: string | null };
  master: ((field: string) => string) | null;
  page?: boolean;
}

class ConvError extends Error {}
type VT = 'string' | 'number' | 'date' | 'boolean' | 'any';
const STR_FN = new Set(['upper', 'lower', 'trim', 'substring', 'left', 'right', 'replace', 'concat', 'reverse', 'tostr', 'format', 'padleft', 'padright']);
const NUM_FN = new Set([
  'len', 'indexof', 'abs', 'round', 'floor', 'ceiling', 'truncate', 'sqrt', 'power', 'exp', 'log', 'log10', 'sign', 'mod', 'rnd', 'sum', 'count', 'avg',
  'countdistinct', 'year', 'month', 'day', 'hour', 'minute', 'second', 'dayofweek', 'dayofyear', 'quarter', 'datediffday', 'datediffmonth', 'datediffyear',
  'toint', 'todouble', 'todecimal', 'pagenumber', 'pagecount', 'rownumber', 'recordnumber',
]);
const DATE_FN = new Set(['now', 'today', 'datetime', 'todate', 'adddays', 'addhours', 'addminutes', 'addmonths', 'addyears']);
const BOOL_FN = new Set(['isnullorempty', 'between', 'like', 'contains', 'startswith', 'endswith', 'tobool']);
const AGG_NAME: Record<SummaryFunc, string> = { none: 'Sum', sum: 'Sum', count: 'Count', avg: 'Avg', min: 'Min', max: 'Max', countDistinct: 'CountDistinct', first: 'First', last: 'Last' };

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` + (d.getHours() || d.getMinutes() || d.getSeconds() ? ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : '');

class Vb {
  private inAgg = 0;
  usedAgg = false;
  constructor(
    private s: Scope,
    private doc: RdlDoc,
  ) {}

  expr(src: string): string {
    let n: Node;
    try {
      n = parse(src);
    } catch (e) {
      throw new ConvError((e as Error).message);
    }
    return this.node(n);
  }

  /** Sum / Count / … of an expression (a control's "Summary" setting), optionally running. */
  summary(src: string, fn: SummaryFunc, running: SummaryRunning): string {
    this.inAgg++;
    let inner: string;
    try {
      inner = this.expr(src);
    } finally {
      this.inAgg--;
    }
    this.usedAgg = true;
    const F = AGG_NAME[fn];
    if (running !== 'none' && fn !== 'first' && fn !== 'last') {
      if (running === 'page') this.doc.warn('Running totals per page are not available in RDL — exported as running totals over the report.');
      const sc = running === 'group' ? this.s.run.group : this.s.run.report;
      return `RunningValue(${inner}, ${F}, ${sc ? q(sc) : 'Nothing'})`;
    }
    return `${F}(${inner}${this.s.agg ? ', ' + q(this.s.agg) : ''})`;
  }

  private lit(v: unknown): string {
    if (v === null || v === undefined) return 'Nothing';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v).replace('e', 'E') : 'Nothing';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (isDate(v)) return `CDate(${q(isoLocal(v))})`;
    return vbStr(String(v));
  }

  type(n: Node): VT {
    switch (n.t) {
      case 'lit':
        return typeof n.v === 'string' ? 'string' : typeof n.v === 'number' ? 'number' : typeof n.v === 'boolean' ? 'boolean' : isDate(n.v) ? 'date' : 'any';
      case 'field': {
        const f = this.s.fields?.get(n.name.toLowerCase());
        return f && f.type !== 'any' ? (f.type as VT) : 'any';
      }
      case 'param': {
        const t = this.doc.paramType(n.name);
        return t === 'number' ? 'number' : t === 'date' ? 'date' : t === 'boolean' ? 'boolean' : t === 'string' ? 'string' : 'any';
      }
      case 'un':
        return n.op === 'not' ? 'boolean' : 'number';
      case 'in':
        return 'boolean';
      case 'bin': {
        if (['and', 'or', '=', '!=', '<', '<=', '>', '>='].includes(n.op)) return 'boolean';
        const a = this.type(n.l);
        const b = this.type(n.r);
        if (n.op === '+') return a === 'string' || b === 'string' ? 'string' : a === 'date' ? 'date' : a === 'number' && b === 'number' ? 'number' : 'any';
        if (n.op === '-') return a === 'date' && b === 'date' ? 'number' : a === 'date' ? 'date' : 'number';
        return 'number';
      }
      case 'call': {
        const f = n.name;
        if (STR_FN.has(f)) return 'string';
        if (NUM_FN.has(f)) return 'number';
        if (DATE_FN.has(f)) return 'date';
        if (BOOL_FN.has(f)) return 'boolean';
        if (f === 'isnull') return n.args.length < 2 ? 'boolean' : this.type(n.args[0]);
        if (f === 'iif') {
          const a = n.args[1] ? this.type(n.args[1]) : 'any';
          const b = n.args[2] ? this.type(n.args[2]) : 'any';
          return a === b ? a : 'any';
        }
        if (['min', 'max', 'first', 'last', 'coalesce'].includes(f) && n.args[0]) return this.type(n.args[0]);
        return 'any';
      }
    }
    return 'any';
  }

  node(n: Node): string {
    switch (n.t) {
      case 'lit':
        return this.lit(n.v);
      case 'param':
        return `Parameters!${this.doc.paramName(n.name)}.Value`;
      case 'field':
        return this.field(n.name);
      case 'un':
        return n.op === 'not' ? `(Not ${this.node(n.e)})` : `(-${this.node(n.e)})`;
      case 'in': {
        const e = this.node(n.e);
        return '(' + n.list.map((x) => `${e} = ${this.node(x)}`).join(' OrElse ') + ')';
      }
      case 'bin': {
        const a = this.node(n.l);
        const b = this.node(n.r);
        switch (n.op) {
          case 'and':
            return `(${a} AndAlso ${b})`;
          case 'or':
            return `(${a} OrElse ${b})`;
          case '+': {
            const ta = this.type(n.l);
            const tb = this.type(n.r);
            if (ta === 'date' && tb === 'number') return `DateAdd(DateInterval.Day, ${b}, ${a})`;
            if (ta === 'string' || tb === 'string') return `(${a} & ${b})`;
            return `(${a} + ${b})`;
          }
          case '-': {
            const ta = this.type(n.l);
            const tb = this.type(n.r);
            if (ta === 'date' && tb === 'date') return `DateDiff(DateInterval.Day, ${b}, ${a})`;
            if (ta === 'date' && tb === 'number') return `DateAdd(DateInterval.Day, -(${b}), ${a})`;
            return `(${a} - ${b})`;
          }
          case '%':
            return `(${a} Mod ${b})`;
          case '!=':
            return `(${a} <> ${b})`;
          default:
            return `(${a} ${n.op} ${b})`;
        }
      }
      case 'call':
        return this.call(n.name, n.args);
    }
  }

  private field(name: string): string {
    const lower = name.toLowerCase();
    if (lower.startsWith('master.')) {
      const rest = name.slice(7);
      if (this.s.master) return `Parameters!${this.s.master(rest)}.Value`;
      throw new ConvError(`[Master.${rest}] can only be used inside a section printed for every parent row`);
    }
    if (!this.s.fields) throw new ConvError(`[${name}] is used where the report has no data source`);
    const f = this.s.fields.get(lower);
    if (!f) this.doc.warn(`Field [${name}] is not in the data source — exported as Fields!${ident(name, 'Field')}.Value.`);
    const ref = `Fields!${f ? f.rdl : ident(name, 'Field')}.Value`;
    if (!this.inAgg && this.s.bare) return `${this.s.bare.fn}(${ref}${this.s.bare.scope ? ', ' + q(this.s.bare.scope) : ''})`;
    return ref;
  }

  private agg(fn: string, args: Node[]): string {
    this.usedAgg = true;
    this.inAgg++;
    try {
      const x = args.length ? this.node(args[0]) : '';
      return `${fn}(${x}${this.s.agg ? ', ' + q(this.s.agg) : ''})`;
    } finally {
      this.inAgg--;
    }
  }

  private call(name: string, args: Node[]): string {
    const A = (i: number) => (args[i] ? this.node(args[i]) : 'Nothing');
    const S = (i: number) => `CStr(${A(i)})`;
    const D = (i: number) => `CDate(${A(i)})`;
    const nest = (fn: (a: string, b: string) => string) => args.map((_, i) => A(i)).reduce((acc, x) => fn(acc, x));
    switch (name) {
      case 'iif': {
        const rec = (i: number): string => (i + 1 < args.length ? `IIf(${A(i)}, ${A(i + 1)}, ${rec(i + 2)})` : i < args.length ? A(i) : 'Nothing');
        return rec(0);
      }
      case 'isnull':
        return args.length < 2 ? `IsNothing(${A(0)})` : `IIf(IsNothing(${A(0)}), ${A(1)}, ${A(0)})`;
      case 'isnullorempty':
        return `(IsNothing(${A(0)}) OrElse ${S(0)} = "")`;
      case 'coalesce': {
        const rec = (i: number): string => (i >= args.length - 1 ? A(i) : `IIf(IsNothing(${A(i)}), ${rec(i + 1)}, ${A(i)})`);
        return args.length ? rec(0) : 'Nothing';
      }
      case 'between':
        return `(${A(0)} >= ${A(1)} AndAlso ${A(0)} <= ${A(2)})`;
      case 'like': {
        const p = args[1];
        if (p && p.t === 'lit' && typeof p.v === 'string') {
          const pat = p.v
            .toUpperCase()
            .replace(/[[*?#]/g, (c) => `[${c}]`)
            .replace(/%/g, '*')
            .replace(/_/g, '?');
          return `(UCase(${S(0)}) Like ${vbStr(pat)})`;
        }
        return `(UCase(${S(0)}) Like UCase(Replace(Replace(${S(1)}, "%", "*"), "_", "?")))`;
      }
      case 'sum':
        return this.agg('Sum', args);
      case 'avg':
        return this.agg('Avg', args);
      case 'countdistinct':
        return this.agg('CountDistinct', args);
      case 'first':
        return this.agg('First', args);
      case 'last':
        return this.agg('Last', args);
      case 'count':
        if (args.length) return this.agg('Count', args);
        this.usedAgg = true;
        return `CountRows(${this.s.agg ? q(this.s.agg) : ''})`;
      case 'min':
        return args.length === 1 ? this.agg('Min', args) : nest((a, b) => `IIf(${a} < ${b}, ${a}, ${b})`);
      case 'max':
        return args.length === 1 ? this.agg('Max', args) : nest((a, b) => `IIf(${a} > ${b}, ${a}, ${b})`);
      case 'abs':
        return `Math.Abs(${A(0)})`;
      case 'round':
        return `Math.Round(CDec(${A(0)}), ${args.length > 1 ? `CInt(${A(1)})` : '0'}, MidpointRounding.AwayFromZero)`;
      case 'floor':
        return `Math.Floor(${A(0)})`;
      case 'ceiling':
        return `Math.Ceiling(${A(0)})`;
      case 'truncate':
        return `Fix(${A(0)})`;
      case 'sqrt':
        return `Math.Sqrt(${A(0)})`;
      case 'power':
        return `(${A(0)} ^ ${A(1)})`;
      case 'exp':
        return `Math.Exp(${A(0)})`;
      case 'log':
        return args.length > 1 ? `Math.Log(${A(0)}, ${A(1)})` : `Math.Log(${A(0)})`;
      case 'log10':
        return `Math.Log10(${A(0)})`;
      case 'sign':
        return `Math.Sign(${A(0)})`;
      case 'mod':
        return `(${A(0)} Mod ${A(1)})`;
      case 'rnd':
        return 'Rnd()';
      case 'len':
        return `Len(${S(0)})`;
      case 'upper':
        return `UCase(${S(0)})`;
      case 'lower':
        return `LCase(${S(0)})`;
      case 'trim':
        return `Trim(${S(0)})`;
      case 'substring': {
        const st = args[1];
        const start = st && st.t === 'lit' && typeof st.v === 'number' ? String(st.v + 1) : `${A(1)} + 1`;
        return args.length > 2 ? `Mid(${S(0)}, ${start}, ${A(2)})` : `Mid(${S(0)}, ${start})`;
      }
      case 'left':
        return `Left(${S(0)}, ${A(1)})`;
      case 'right':
        return `Right(${S(0)}, ${A(1)})`;
      case 'replace':
        return `Replace(${S(0)}, ${S(1)}, ${S(2)})`;
      case 'contains':
        return `(InStr(UCase(${S(0)}), UCase(${S(1)})) > 0)`;
      case 'startswith':
        return `UCase(${S(0)}).StartsWith(UCase(${S(1)}))`;
      case 'endswith':
        return `UCase(${S(0)}).EndsWith(UCase(${S(1)}))`;
      case 'indexof':
        return `(InStr(${S(0)}, ${S(1)}) - 1)`;
      case 'padleft':
        return `${S(0)}.PadLeft(CInt(${A(1)}), ${args.length > 2 ? `CChar(${S(2)})` : '" "c'})`;
      case 'padright':
        return `${S(0)}.PadRight(CInt(${A(1)}), ${args.length > 2 ? `CChar(${S(2)})` : '" "c'})`;
      case 'concat':
        return '(' + args.map((_, i) => S(i)).join(' & ') + ')';
      case 'reverse':
        return `StrReverse(${S(0)})`;
      case 'tostr':
        return S(0);
      case 'format': {
        const f = args[1];
        if (f && f.t === 'lit' && typeof f.v === 'string' && f.v.includes('{0')) return `String.Format(${vbStr(f.v)}, ${args.filter((_, i) => i !== 1).map((_, i) => A(i === 0 ? 0 : i + 1)).join(', ')})`;
        return `Format(${A(0)}, ${A(1)})`;
      }
      case 'now':
        return 'Now';
      case 'today':
        return 'Today';
      case 'datetime':
        return `DateSerial(${A(0)}, ${A(1)}, ${args.length > 2 ? A(2) : '1'})`;
      case 'todate':
        return D(0);
      case 'year':
        return `Year(${D(0)})`;
      case 'month':
        return `Month(${D(0)})`;
      case 'day':
        return `Day(${D(0)})`;
      case 'hour':
        return `Hour(${D(0)})`;
      case 'minute':
        return `Minute(${D(0)})`;
      case 'second':
        return `Second(${D(0)})`;
      case 'dayofweek':
        return `(Weekday(${D(0)}) - 1)`;
      case 'dayofyear':
        return `DatePart(DateInterval.DayOfYear, ${D(0)})`;
      case 'quarter':
        return `DatePart(DateInterval.Quarter, ${D(0)})`;
      case 'adddays':
        return `DateAdd(DateInterval.Day, ${A(1)}, ${D(0)})`;
      case 'addhours':
        return `DateAdd(DateInterval.Hour, ${A(1)}, ${D(0)})`;
      case 'addminutes':
        return `DateAdd(DateInterval.Minute, ${A(1)}, ${D(0)})`;
      case 'addmonths':
        return `DateAdd(DateInterval.Month, ${A(1)}, ${D(0)})`;
      case 'addyears':
        return `DateAdd(DateInterval.Year, ${A(1)}, ${D(0)})`;
      case 'datediffday':
        return `DateDiff(DateInterval.Day, ${D(0)}, ${D(1)})`;
      case 'datediffmonth':
        return `DateDiff(DateInterval.Month, ${D(0)}, ${D(1)})`;
      case 'datediffyear':
        return `DateDiff(DateInterval.Year, ${D(0)}, ${D(1)})`;
      case 'toint':
        return `CInt(Fix(${A(0)}))`;
      case 'todouble':
        return `CDbl(${A(0)})`;
      case 'todecimal':
        return `CDec(${A(0)})`;
      case 'tobool':
        return `CBool(${A(0)})`;
      case 'pagenumber':
        return 'Globals!PageNumber';
      case 'pagecount':
        return 'Globals!TotalPages';
      case 'rownumber':
        return `RowNumber(${this.s.rowScope ? q(this.s.rowScope) : 'Nothing'})`;
      case 'recordnumber':
        return 'RowNumber(Nothing)';
      case 'reportname':
        return 'Globals!ReportName';
    }
    throw new ConvError(`function ${name}() has no RDL equivalent`);
  }
}

/** Split "Total: {Sum([Amount])}" into literal and expression parts ({{ and }} escape braces). */
function splitInterpolation(text: string): { lit?: string; expr?: string }[] {
  const out: { lit?: string; expr?: string }[] = [];
  let lit = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if ((c === '{' && text[i + 1] === '{') || (c === '}' && text[i + 1] === '}')) {
      lit += c;
      i += 2;
      continue;
    }
    if (c === '{') {
      let j = i + 1;
      let qc = '';
      let depth = 1;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (qc) {
          if (ch === qc) qc = '';
          continue;
        }
        if (ch === "'" || ch === '"') qc = ch;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) break;
      }
      if (j >= text.length) {
        lit += text.slice(i);
        break;
      }
      if (lit) out.push({ lit });
      lit = '';
      out.push({ expr: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    lit += c;
    i++;
  }
  if (lit) out.push({ lit });
  return out;
}

// ------------------------------------------------------------------ report writer
interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ItemCtx {
  scope: Scope;
  where: 'body' | 'cell' | 'page';
  dataset: string | null;
}
interface RuleSet {
  list: { cond: string; style: StyleProps }[];
}
const NO_RULES: RuleSet = { list: [] };
interface RowSpec {
  height: number;
  cell: string;
  hidden?: string | null;
  keepTogether?: boolean;
  repeat?: boolean;
}
interface GroupLevel {
  name: string;
  expr: string;
  sort: 'asc' | 'desc' | 'none';
  header?: RowSpec;
  footer?: RowSpec;
  pageBreak: string | null;
}
interface DataSetInfo {
  name: string;
  dsId: string;
  fields: FieldMap;
  filters: string[];
}
interface Shared {
  files: RdlFile[];
  warnings: string[];
  fileNames: Set<string>;
}
const LINE_STYLE: Record<string, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };
const RDL_TYPE: Record<string, string> = { string: 'String', number: 'Float', date: 'DateTime', boolean: 'Boolean', any: 'String' };
const TYPE_NAME: Record<string, string> = { string: 'System.String', number: 'System.Decimal', date: 'System.DateTime', boolean: 'System.Boolean' };
const XML_TYPE: Record<string, string> = { number: 'Decimal', date: 'Date', boolean: 'Boolean' };

function getPath(o: unknown, path: string): unknown {
  if (o && typeof o === 'object' && path in (o as Row)) return (o as Row)[path];
  return path.split('.').reduce<unknown>((c, p) => (c && typeof c === 'object' ? (c as Row)[p] : undefined), o);
}
function xmlValue(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (isDate(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}T${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const s = String(v);
    return /e/i.test(s) ? v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : s;
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class RdlDoc {
  private names = new Set<string>();
  private images = new Map<string, { name: string; mime: string; data: string }>();
  private fieldMaps = new Map<string, FieldMap>();
  private sets = new Map<string, DataSetInfo>();
  private sources = new Map<string, { name: string; xml: string }>();
  private params = new Map<string, { rdl: string; def: ParameterDef }>();
  /** hidden parameters of a subreport (keys and parent-row values) */
  extraParams: { name: string; type: string }[] = [];
  keyFilters: { child: string; param: string }[] = [];
  masterFn: ((field: string) => string) | null = null;
  hideReportParams = false;
  private pageAggWarned = false;
  readonly cw: number;

  constructor(
    readonly r: ReportDef,
    readonly o: RdlOptions,
    readonly g: Shared,
  ) {
    this.cw = contentWidth(r);
    for (const p of r.parameters) {
      const rdl = this.uniq(ident(p.name, 'Param'));
      this.params.set(p.name.toLowerCase(), { rdl, def: p });
    }
  }

  warn(msg: string) {
    if (!this.g.warnings.includes(msg)) this.g.warnings.push(msg);
  }
  /** unique name across report items, groups, data sets and data regions */
  uniq(base: string): string {
    let n = ident(base);
    if (this.names.has(n.toLowerCase())) {
      let i = 2;
      while (this.names.has(`${n}_${i}`.toLowerCase())) i++;
      n = `${n}_${i}`;
    }
    this.names.add(n.toLowerCase());
    return n;
  }
  paramName(name: string) {
    const p = this.params.get(name.toLowerCase());
    if (p) return p.rdl;
    const extra = this.extraParams.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (extra) return extra.name;
    this.warn(`Parameter ?${name} is not defined in the report.`);
    return ident(name, 'Param');
  }
  paramType(name: string) {
    return this.params.get(name.toLowerCase())?.def.type ?? null;
  }
  addParam(base: string, type: string) {
    const name = this.uniq(base);
    this.extraParams.push({ name, type });
    return name;
  }

  mkScope(fields: FieldMap | null, o: Partial<Scope> = {}): Scope {
    return { fields, agg: null, bare: null, rowScope: null, run: { report: null, group: null }, master: this.masterFn, ...o };
  }
  vb(src: string, s: Scope): string {
    return new Vb(s, this).expr(src);
  }
  tryVb(src: string, s: Scope, what: string): string | null {
    try {
      return this.vb(src, s);
    } catch (e) {
      this.warn(`${what}: "${src}" could not be converted (${(e as Error).message}).`);
      return null;
    }
  }

  // ---------------------------------------------------------------- data
  fieldMap(dsId: string): FieldMap {
    let m = this.fieldMaps.get(dsId);
    if (m) return m;
    m = new Map();
    const ds = this.r.dataSources.find((d) => d.id === dsId);
    const defs = ds?.fields?.length ? ds.fields : inferFields(this.o.rows(dsId));
    const used = new Set<string>();
    const name = (base: string) => {
      let n = ident(base, 'Field');
      let i = 2;
      while (used.has(n.toLowerCase())) n = `${ident(base, 'Field')}_${i++}`;
      used.add(n.toLowerCase());
      return n;
    };
    for (const f of defs) if (!m.has(f.name.toLowerCase())) m.set(f.name.toLowerCase(), { rdl: name(f.name), type: f.type, dataField: f.name, source: f.name });
    // calculated fields whose inputs exist in this data source
    const calcs = this.r.calculatedFields.filter((c) => c.name && c.expression && !m!.has(c.name.toLowerCase()));
    const known = new Set([...m.keys(), ...calcs.map((c) => c.name.toLowerCase())]);
    const usable = calcs.filter((c) => referencedFields(c.expression).every((f) => known.has(f.toLowerCase()) || /^master\./i.test(f)));
    for (const c of usable) m.set(c.name.toLowerCase(), { rdl: name(c.name), type: 'any', calc: c.expression });
    const scope = this.mkScope(m, { master: null });
    for (const c of usable) {
      const info = m.get(c.name.toLowerCase())!;
      const v = this.tryVb(c.expression, scope, `Calculated field "${c.name}"`);
      if (v) info.calc = v;
      else m.delete(c.name.toLowerCase());
    }
    this.fieldMaps.set(dsId, m);
    return m;
  }

  /** a data set for a data source with its filters (filter VB expressions without '=') */
  dataset(dsId: string, filters: string[]): DataSetInfo {
    const key = dsId + '\u0001' + filters.join('\u0002');
    let s = this.sets.get(key);
    if (!s) {
      const ds = this.r.dataSources.find((d) => d.id === dsId)!;
      s = { name: this.uniq(ident(ds?.name ?? 'DataSet', 'DataSet')), dsId, fields: this.fieldMap(dsId), filters };
      this.sets.set(key, s);
    }
    return s;
  }

  private connection(ds: DataSourceDef): { name: string; provider: string } {
    const src = ds.sql!;
    const conn = this.o.connections.find((c) => c.id === src.connectionId);
    const key = 'conn:' + (conn?.id ?? src.connectionId ?? src.connectionName ?? '?');
    let s = this.sources.get(key);
    const provider = conn?.provider ?? 'mssql';
    if (!s) {
      const name = this.uniq(ident(conn?.name ?? src.connectionName ?? 'Database', 'DataSource'));
      let dp = 'SQL';
      let cs = '';
      let integrated = false;
      const host = conn?.host ?? '';
      const port = conn?.port ? String(conn.port) : '';
      const db = conn?.database ?? '';
      if (!conn) this.warn(`Database connection "${src.connectionName ?? src.connectionId}" is not saved on this computer — set the connection string of data source "${name}" in Report Builder.`);
      switch (provider) {
        case 'mssql':
          cs = `Data Source=${host}${conn?.instance ? '\\' + conn.instance : port && port !== '1433' ? ',' + port : ''};Initial Catalog=${db}`;
          integrated = conn?.auth === 'ntlm';
          break;
        case 'oracle':
          dp = 'ORACLE';
          cs = conn?.connectString || `Data Source=${host}:${port || '1521'}/${db}`;
          break;
        case 'postgres':
          dp = 'ODBC';
          cs = `Driver={PostgreSQL Unicode};Server=${host};Port=${port || '5432'};Database=${db};`;
          break;
        case 'mysql':
          dp = 'ODBC';
          cs = `Driver={MySQL ODBC 8.0 Unicode Driver};Server=${host};Port=${port || '3306'};Database=${db};`;
          break;
        case 'sqlite':
          dp = 'ODBC';
          cs = `Driver={SQLite3 ODBC Driver};Database=${conn?.file ?? db};`;
          break;
      }
      if (dp === 'ODBC') this.warn(`Data source "${name}" uses ODBC (${provider}): install the ODBC driver on the report server and check the driver name in the connection string.`);
      const xml = EN(
        'DataSource',
        name,
        E('ConnectionProperties', T('DataProvider', dp) + TE('ConnectString', cs) + (integrated ? T('IntegratedSecurity', 'true') : T('Prompt', `Enter a user name and password to access ${conn?.name ?? name}`))) +
          `<rd:SecurityType>${integrated ? 'Integrated' : 'DataBase'}</rd:SecurityType><rd:DataSourceID>${uuid()}</rd:DataSourceID>`,
      );
      s = { name, xml };
      this.sources.set(key, s);
    }
    return { name: s.name, provider };
  }

  private embeddedSource(): string {
    let s = this.sources.get('xml');
    if (!s) {
      const name = this.uniq('EmbeddedData');
      s = { name, xml: EN('DataSource', name, E('ConnectionProperties', T('DataProvider', 'XML') + TE('ConnectString', '')) + `<rd:DataSourceID>${uuid()}</rd:DataSourceID>`) };
      this.sources.set('xml', s);
    }
    return s.name;
  }

  private sqlQuery(src: SqlSource, provider: string): { type: string; text: string; params: { name: string; value: string }[] } {
    const quote = (p: string) => (provider === 'mssql' ? `[${p.replace(/]/g, ']]')}]` : provider === 'mysql' ? '`' + p.replace(/`/g, '``') + '`' : `"${p.replace(/"/g, '""')}"`);
    const obj = [src.schema, src.pkg, src.name]
      .filter((x): x is string => !!x)
      .map(quote)
      .join('.');
    const style = provider === 'mssql' ? '@' : provider === 'oracle' ? ':' : '?';
    const ins = (src.params ?? []).filter((p) => p.mode !== 'OUT');
    const pscope = this.mkScope(null, { master: null });
    const value = (expr: string) => {
      if (!expr?.trim()) return '=Nothing';
      const v = this.tryVb(expr, pscope, 'Database parameter');
      return v ? '=' + v : '=Nothing';
    };
    const named = (n: string) => (style === '?' ? '?' : style + n);
    const qp = (list: { name: string; value: string }[]) => list;
    let params = ins.map((p, i) => ({ name: style === '?' ? `Parameter${i + 1}` : style + p.name, value: value(p.value) }));
    let type = 'Text';
    let text = '';
    switch (src.mode) {
      case 'table':
      case 'view':
        text = `SELECT * FROM ${obj}`;
        params = [];
        break;
      case 'procedure':
        if (provider === 'mssql' || provider === 'oracle') {
          type = 'StoredProcedure';
          text = [src.schema, src.pkg, src.name].filter(Boolean).join('.');
          if (provider === 'oracle') params = ins.map((p) => ({ name: p.name, value: value(p.value) }));
        } else text = `CALL ${obj}(${ins.map((p) => named(p.name)).join(', ')})`;
        break;
      case 'function': {
        const args = ins.map((p) => named(p.name)).join(', ');
        if (provider === 'oracle') text = src.returnsTable ? `SELECT * FROM TABLE(${obj}(${args}))` : `SELECT ${obj}(${args}) AS VALUE FROM DUAL`;
        else if (provider === 'mssql') text = src.returnsTable ? `SELECT * FROM ${obj}(${args})` : `SELECT ${obj}(${args}) AS [Value]`;
        else if (provider === 'postgres') text = `SELECT * FROM ${obj}(${args})`;
        else text = `SELECT ${obj}(${args}) AS Value`;
        break;
      }
      default: {
        // custom query: rewrite @name / :name markers to the provider's style
        const known = new Map(ins.map((p) => [p.name.toLowerCase(), p]));
        const order: typeof ins = [];
        text = rewriteMarkers(src.query ?? '', (n) => {
          const p = known.get(n.toLowerCase());
          if (!p) return null;
          order.push(p);
          return named(p.name);
        });
        if (style === '?') params = order.map((p, i) => ({ name: `Parameter${i + 1}`, value: value(p.value) }));
      }
    }
    return { type, text, params: qp(params) };
  }

  private datasetXml(s: DataSetInfo): string {
    const ds = this.r.dataSources.find((d) => d.id === s.dsId)!;
    let query = '';
    const plain = [...s.fields.values()].filter((f) => f.dataField);
    if (ds.kind === 'sql' && ds.sql) {
      const c = this.connection(ds);
      const qy = this.sqlQuery(ds.sql, c.provider);
      query = E(
        'Query',
        T('DataSourceName', c.name) +
          (qy.type !== 'Text' ? T('CommandType', qy.type) : '') +
          TE('CommandText', qy.text) +
          (qy.params.length ? E('QueryParameters', qy.params.map((p) => EN('QueryParameter', p.name, TE('Value', p.value))).join('')) : ''),
      );
    } else {
      const max = this.o.maxEmbeddedRows ?? 5000;
      const all = this.o.rows(s.dsId);
      if (all.length > max) this.warn(`Data source "${ds.name}": only the first ${max} of ${all.length} rows are embedded in the RDL.`);
      if (ds.kind === 'url') this.warn(`Data source "${ds.name}" (web URL) is embedded as a snapshot of its current rows.`);
      const rowsXml = all
        .slice(0, max)
        .map(
          (row) =>
            '<Row' +
            plain
              .map((f) => {
                const v = xmlValue(getPath(row, f.source ?? f.dataField!));
                // attribute values: keep line breaks / tabs (XML would turn them into spaces)
                return v === null ? '' : ` ${f.rdl}="${xesc(v).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')}"`;
              })
              .join('') +
            '/>',
        )
        .join('');
      const path = `Rows{}/Row{${plain.map((f) => '@' + f.rdl + (XML_TYPE[f.type] ? `(${XML_TYPE[f.type]})` : '')).join(', ')}}`;
      const text = `<Query><ElementPath>${xesc(path)}</ElementPath><XmlData><Rows>${rowsXml}</Rows></XmlData></Query>`;
      query = E('Query', T('DataSourceName', this.embeddedSource()) + TE('CommandText', text));
    }
    const fields = [...s.fields.values()]
      .map((f) =>
        f.dataField
          ? EN('Field', f.rdl, T('DataField', ds.kind === 'sql' ? f.dataField : f.rdl) + (TYPE_NAME[f.type] ? `<rd:TypeName>${TYPE_NAME[f.type]}</rd:TypeName>` : ''))
          : EN('Field', f.rdl, TE('Value', '=' + f.calc)),
      )
      .join('');
    const filters = s.filters.length ? E('Filters', s.filters.join('')) : '';
    return EN('DataSet', s.name, query + (fields ? E('Fields', fields) : '') + filters);
  }

  // ---------------------------------------------------------------- images
  private embed(mime: string, data: string): string {
    const key = mime + ',' + data;
    let im = this.images.get(key);
    if (!im) {
      im = { name: this.uniq('Image' + (this.images.size + 1)), mime, data };
      this.images.set(key, im);
    }
    return im.name;
  }
  private async imageSource(src: string): Promise<{ source: 'Embedded' | 'External'; value: string } | null> {
    if (!src.startsWith('data:')) return { source: 'External', value: src };
    let url = src;
    let mime = (/^data:([^;,]+)/.exec(src)?.[1] ?? '').toLowerCase();
    const ok = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/x-png'];
    if (!ok.includes(mime) || !/;base64,/i.test(src.slice(0, src.indexOf(',') + 1))) {
      try {
        url = await toDataUrl(src);
        mime = 'image/png';
      } catch {
        this.warn('A picture could not be converted to PNG and was left out.');
        return null;
      }
    }
    if (mime === 'image/jpg') mime = 'image/jpeg';
    return { source: 'Embedded', value: this.embed(mime, url.slice(url.indexOf(',') + 1)) };
  }
  /** draw a control (shape, barcode) into a PNG */
  private async elementPng(el: ReportElement): Promise<string | null> {
    try {
      const env: LayoutEnv = { report: this.r, ctx: { row: null, rows: [], params: {} }, design: true, bandType: 'detail' };
      const L = layoutElement(el, env);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${el.width}" height="${el.height}" viewBox="0 0 ${el.width} ${el.height}">${primsToSvg(L.prims)}</svg>`;
      const c = await svgToCanvas(svg, el.width, el.height, 2);
      return c.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- styles
  private rules(el: ReportElement, s: Scope): RuleSet {
    const list: RuleSet['list'] = [];
    for (const rule of el.formatRules ?? []) {
      if (!rule.condition?.trim()) continue;
      const c = this.tryVb(rule.condition, { ...s, bare: s.bare }, `Format rule of ${el.name}`);
      if (c) list.push({ cond: `CBool(${c})`, style: rule.style ?? {} });
    }
    return { list };
  }
  private rprop(base: string | null, R: RuleSet, pick: (st: StyleProps) => string | null | undefined): string | null {
    const rs = R.list.filter((x) => pick(x.style) !== null && pick(x.style) !== undefined);
    if (!rs.length) return base;
    let acc = vbStr(base ?? '');
    for (const x of rs) acc = `IIf(${x.cond}, ${vbStr(pick(x.style)!)}, ${acc})`;
    return '=' + acc;
  }
  private hidden(el: ReportElement, s: Scope): string | null {
    const conds: string[] = [];
    if (el.visibleExpr?.trim()) {
      const v = this.tryVb(el.visibleExpr, s, `Visible expression of ${el.name}`);
      if (v) conds.push(`Not CBool(${v})`);
    }
    for (const rule of el.formatRules ?? []) {
      if (!rule.hide || !rule.condition?.trim()) continue;
      const v = this.tryVb(rule.condition, s, `Format rule of ${el.name}`);
      if (v) conds.push(`CBool(${v})`);
    }
    return conds.length ? '=' + conds.map((c) => `(${c})`).join(' OrElse ') : null;
  }
  private borderXml(st: ResolvedStyle, R: RuleSet): string {
    const sides = st.borders || '';
    if (!sides || st.borderWidth <= 0) return NO_BORDER;
    const c = this.rprop(color(st.borderColor) ?? '#000000', R, (x) => (x.borderColor ? color(x.borderColor) : null));
    const one = (tag: string, letter: string) => (sides.includes(letter) ? E(tag, T('Color', c) + T('Style', LINE_STYLE[st.borderStyle] ?? 'Solid') + T('Width', pt(st.borderWidth))) : '');
    return NO_BORDER + one('TopBorder', 't') + one('BottomBorder', 'b') + one('LeftBorder', 'l') + one('RightBorder', 'r');
  }
  private boxStyle(st: ResolvedStyle, R: RuleSet, o: { bg?: string | null; noPad?: boolean } = {}): string {
    let x = this.borderXml(st, R);
    const base = o.bg !== undefined ? o.bg : color(st.backColor);
    const bg = this.rprop(base ?? 'Transparent', R, (s) => (s.backColor !== undefined ? (color(s.backColor) ?? 'Transparent') : null));
    if (bg && bg !== 'Transparent') x += T('BackgroundColor', bg);
    x += T('VerticalAlign', { top: 'Top', middle: 'Middle', bottom: 'Bottom' }[st.vAlign] ?? 'Top');
    if (!o.noPad) {
      const p = pt(st.padding ?? 0);
      x += T('PaddingLeft', p) + T('PaddingRight', p) + T('PaddingTop', p) + T('PaddingBottom', p);
    }
    return E('Style', x);
  }
  private runStyle(st: ResolvedStyle, R: RuleSet, format: string): string {
    const deco = (s: { underline?: boolean; strike?: boolean }) => (s.underline ? 'Underline' : s.strike ? 'LineThrough' : 'None');
    return E(
      'Style',
      T('FontFamily', this.rprop(st.fontFamily, R, (s) => s.fontFamily)) +
        T('FontSize', this.rprop(`${st.fontSize}pt`, R, (s) => (s.fontSize ? `${s.fontSize}pt` : null))) +
        T('FontWeight', this.rprop(st.bold ? 'Bold' : 'Normal', R, (s) => (s.bold === undefined ? null : s.bold ? 'Bold' : 'Normal'))) +
        T('FontStyle', this.rprop(st.italic ? 'Italic' : 'Normal', R, (s) => (s.italic === undefined ? null : s.italic ? 'Italic' : 'Normal'))) +
        T('TextDecoration', this.rprop(deco(st), R, (s) => (s.underline === undefined && s.strike === undefined ? null : deco(s)))) +
        T('Color', this.rprop(color(st.color) ?? '#000000', R, (s) => (s.color ? color(s.color) : null))) +
        T('Format', format),
    );
  }
  private textbox(
    name: string,
    g: Geom | null,
    value: string,
    st: ResolvedStyle,
    R: RuleSet,
    o: { format?: string; canGrow?: boolean; canShrink?: boolean; hidden?: string | null; z?: number; docMap?: string | null } = {},
  ): string {
    const paras = value.startsWith('=') ? [value] : value.replace(/\r\n?/g, '\n').split('\n');
    const align = { left: 'Left', center: 'Center', right: 'Right', justify: 'Left' }[st.textAlign] ?? 'Left';
    const P = E(
      'Paragraphs',
      paras.map((v) => E('Paragraph', E('TextRuns', E('TextRun', TE('Value', v) + this.runStyle(st, R, o.format ?? ''))) + E('Style', T('TextAlign', align)))).join(''),
    );
    return EN(
      'Textbox',
      name,
      T('CanGrow', o.canGrow ? 'true' : 'false') +
        (o.canShrink ? T('CanShrink', 'true') : '') +
        T('KeepTogether', 'true') +
        P +
        `<rd:DefaultName>${xesc(name)}</rd:DefaultName>` +
        geom(g) +
        T('ZIndex', o.z) +
        (o.hidden ? E('Visibility', T('Hidden', o.hidden)) : '') +
        T('DocumentMapLabel', o.docMap) +
        this.boxStyle(st, R),
    );
  }

  /** value (+ RDL Format) of a label / cell: expression, summary, static text or "{expr}" text */
  private textValue(
    el: { text: string; expression: string; format: string; summaryFunc: SummaryFunc; nullText?: string },
    running: SummaryRunning,
    s: Scope,
    what: string,
  ): { value: string; format: string } {
    const fmt = el.format || '';
    const composite = fmt.includes('{0');
    if (el.expression?.trim()) {
      let v: string;
      try {
        const w = new Vb(s, this);
        v = el.summaryFunc && el.summaryFunc !== 'none' ? w.summary(el.expression, el.summaryFunc, running) : w.expr(el.expression);
        if (s.page && w.usedAgg && !this.pageAggWarned) {
          this.pageAggWarned = true;
          this.warn('Totals in the Page Header / Footer are computed over the whole report in RDL (not per page).');
        }
      } catch (e) {
        this.warn(`${what}: "${el.expression}" could not be converted (${(e as Error).message}) — shown as text.`);
        return { value: el.expression, format: '' };
      }
      if (el.nullText) v = `IIf(IsNothing(${v}), ${vbStr(el.nullText)}, ${v})`;
      if (composite) return { value: `=String.Format(${vbStr(fmt)}, ${v})`, format: '' };
      return { value: '=' + v, format: fmt };
    }
    let text = el.text ?? '';
    if (text.includes('{') || text.includes('}')) {
      const parts = splitInterpolation(text);
      if (parts.some((p) => p.expr !== undefined)) {
        const out = parts.map((p) => {
          if (p.expr === undefined) return vbStr(p.lit ?? '');
          try {
            return `CStr(${this.vb(p.expr, s)})`;
          } catch (e) {
            this.warn(`${what}: "{${p.expr}}" could not be converted (${(e as Error).message}).`);
            return vbStr('{' + p.expr + '}');
          }
        });
        return { value: '=' + out.join(' & '), format: '' };
      }
      text = parts.map((p) => p.lit ?? '').join('');
    }
    if (fmt && text.trim() && !isNaN(Number(text)) && !composite) return { value: '=' + Number(text), format: fmt };
    if (text.startsWith('=')) return { value: '=' + vbStr(text), format: '' };
    return { value: text, format: '' };
  }

  // ---------------------------------------------------------------- report items
  async item(el: ReportElement, ic: ItemCtx, z: number): Promise<string> {
    const s = ic.scope;
    const R = this.rules(el, s);
    const hidden = this.hidden(el, s);
    const g: Geom = { x: el.x, y: el.y, w: el.width, h: el.height };
    const st = resolveStyle(this.r, el.styleName, el.style);
    const docMap = el.bookmark?.trim() ? this.tryVb(el.bookmark, s, `Bookmark of ${el.name}`) : null;
    const dm = docMap ? '=' + docMap : null;
    switch (el.type) {
      case 'text': {
        const tv = this.textValue(el, el.summaryRunning, s, el.name);
        return this.textbox(this.uniq(el.name || 'Textbox'), g, tv.value, st, R, { format: tv.format, canGrow: el.canGrow, canShrink: el.canShrink, hidden, z, docMap: dm });
      }
      case 'checkbox': {
        const label = el.text ? ' ' + el.text : '';
        let value = (el.checked ? '☑' : '☐') + label;
        if (el.expression.trim()) {
          const v = this.tryVb(el.expression, s, el.name);
          if (v) value = `=IIf(CBool(${v}), "☑", "☐")` + (label ? ` & ${vbStr(label)}` : '');
        }
        return this.textbox(this.uniq(el.name || 'CheckBox'), g, value, { ...st, fontFamily: 'Segoe UI Symbol' }, R, { hidden, z });
      }
      case 'pageInfo': {
        const f = el.format;
        let value = '';
        let format = '';
        switch (el.info) {
          case 'pageNumber':
            value = f && f !== '{0}' ? `=String.Format(${vbStr(f)}, Globals!PageNumber, Globals!TotalPages)` : '=Globals!PageNumber';
            break;
          case 'pageNofM':
            value = `=String.Format(${vbStr(f || 'Page {0} of {1}')}, Globals!PageNumber, Globals!TotalPages)`;
            break;
          case 'totalPages':
            value = f && f !== '{0}' ? `=String.Format(${vbStr(f)}, Globals!TotalPages)` : '=Globals!TotalPages';
            break;
          case 'date':
          case 'time':
          case 'dateTime':
            value = '=Globals!ExecutionTime';
            format = f || (el.info === 'date' ? 'd' : el.info === 'time' ? 't' : 'g');
            break;
          case 'reportName':
            value = f && f.includes('{0') ? `=String.Format(${vbStr(f)}, Globals!ReportName)` : '=Globals!ReportName';
            break;
        }
        return this.textbox(this.uniq(el.name || 'PageInfo'), g, value, st, R, { format, hidden, z });
      }
      case 'table': {
        // one text box per cell; a merged cell is one text box over all the cells it spans
        const out: string[] = [];
        const owners = cellOwners(el);
        el.rows.forEach((row, ri) => {
          row.cells.forEach((c, ci) => {
            if (el.columns[ci] === undefined) return;
            const o = owners[ri][ci];
            if (o.row !== ri || o.col !== ci) return;
            const rc = cellRectOf(el, ri, ci);
            const cst = resolveStyle(this.r, el.styleName, el.style, c.style);
            const tv = this.textValue({ ...c, nullText: '' }, 'none', s, `${el.name} (row ${ri + 1}, column ${ci + 1})`);
            out.push(this.textbox(this.uniq(`${el.name}_r${ri + 1}c${ci + 1}`), { x: el.x + rc.x, y: el.y + rc.y, w: rc.w, h: rc.h }, tv.value, cst, R, { format: tv.format, canGrow: el.canGrow, hidden, z }));
          });
        });
        return out.join('');
      }
      case 'line': {
        let top = el.y;
        let left = el.x;
        let H = el.height;
        let W = el.width;
        if (el.direction === 'horizontal') {
          top += el.height / 2;
          H = 0;
        } else if (el.direction === 'vertical') {
          left += el.width / 2;
          W = 0;
        } else if (el.direction === 'slantUp') {
          top += el.height;
          H = -el.height;
        }
        return EN(
          'Line',
          this.uniq(el.name || 'Line'),
          T('Top', mm(top)) +
            T('Left', mm(left)) +
            T('Height', mm(H)) +
            T('Width', mm(W)) +
            T('ZIndex', z) +
            (hidden ? E('Visibility', T('Hidden', hidden)) : '') +
            E('Style', E('Border', T('Color', color(el.lineColor) ?? '#000000') + T('Style', LINE_STYLE[el.lineStyle] ?? 'Solid') + T('Width', pt(el.lineWidth)))),
        );
      }
      case 'shape': {
        if (el.shape === 'rectangle') {
          const border = el.lineWidth > 0 ? E('Border', T('Color', color(el.lineColor) ?? '#000000') + T('Style', LINE_STYLE[el.lineStyle] ?? 'Solid') + T('Width', pt(el.lineWidth))) : NO_BORDER;
          return EN(
            'Rectangle',
            this.uniq(el.name || 'Rectangle'),
            geom(g) + T('ZIndex', z) + (hidden ? E('Visibility', T('Hidden', hidden)) : '') + E('Style', border + T('BackgroundColor', color(el.fillColor))),
          );
        }
        return this.pictureOf(el, g, z, hidden);
      }
      case 'image':
        return this.image(el, g, z, hidden, st, s);
      case 'barcode': {
        if (!el.expression.trim()) return this.pictureOf(el, g, z, hidden);
        this.warn(`Barcode "${el.name}" is bound to data: RDL has no barcode control — exported as a text box with the value (use a barcode font or a custom report item).`);
        const v = this.tryVb(el.expression, s, el.name);
        return this.textbox(this.uniq(el.name || 'Barcode'), g, v ? '=' + v : el.expression, st, R, { hidden, z });
      }
      case 'chart':
        if (ic.where === 'page') {
          this.warn(`Chart "${el.name}" is in a page header / footer — RDL does not allow charts there; it was left out.`);
          return '';
        }
        return this.chart(el, ic, g, z, hidden, st);
      case 'crosstab':
        if (ic.where === 'page') {
          this.warn(`Cross tab "${el.name}" is in a page header / footer — RDL does not allow it there; it was left out.`);
          return '';
        }
        return this.crosstab(el, ic, g, z, hidden, st);
    }
    return '';
  }

  private async pictureOf(el: ReportElement, g: Geom, z: number, hidden: string | null): Promise<string> {
    const png = await this.elementPng(el);
    if (!png) {
      this.warn(`"${el.name}" could not be drawn as a picture and was left out.`);
      return '';
    }
    const name = this.embed('image/png', png.slice(png.indexOf(',') + 1));
    return EN(
      'Image',
      this.uniq(el.name || 'Image'),
      T('Source', 'Embedded') + TE('Value', name) + T('Sizing', 'Fit') + geom(g) + T('ZIndex', z) + (hidden ? E('Visibility', T('Hidden', hidden)) : '') + E('Style', NO_BORDER),
    );
  }

  private async image(el: ImageElement, g: Geom, z: number, hidden: string | null, st: ResolvedStyle, s: Scope): Promise<string> {
    let src: { source: 'Embedded' | 'External'; value: string } | null = null;
    if (el.expression.trim()) {
      const v = this.tryVb(el.expression, s, el.name);
      if (v) src = { source: 'External', value: '=' + v };
    } else if (el.src) src = await this.imageSource(el.src);
    if (!src) return '';
    const sizing = el.sizing === 'stretch' ? 'Fit' : el.sizing === 'cover' ? 'Clip' : 'FitProportional';
    return EN(
      'Image',
      this.uniq(el.name || 'Image'),
      T('Source', src.source) + TE('Value', src.value) + T('Sizing', sizing) + geom(g) + T('ZIndex', z) + (hidden ? E('Visibility', T('Hidden', hidden)) : '') + this.boxStyle(st, NO_RULES, { noPad: true }),
    );
  }

  private chart(el: ChartElement, ic: ItemCtx, g: Geom, z: number, hidden: string | null, st: ResolvedStyle): string {
    if (!ic.dataset || !ic.scope.fields) {
      this.warn(`Chart "${el.name}" has no data source here — left out.`);
      return '';
    }
    const s = { ...ic.scope, bare: null, agg: null };
    const cat = el.argument.trim() ? this.tryVb(el.argument, s, `Chart ${el.name} argument`) : null;
    const val = el.value.trim() ? this.tryVb(el.value, s, `Chart ${el.name} value`) : null;
    if (!cat || !val) {
      this.warn(`Chart "${el.name}" needs an argument and a value — left out.`);
      return '';
    }
    const F = el.aggregate === 'none' ? 'Sum' : AGG_NAME[el.aggregate];
    const Y = `${F}(${val})`;
    const name = this.uniq(el.name || 'Chart');
    const catGroup = this.uniq(name + '_Categories');
    const sort =
      el.sortBy === 'argument'
        ? E('SortExpressions', E('SortExpression', TE('Value', '=' + cat)))
        : el.sortBy === 'valueAsc' || el.sortBy === 'valueDesc'
          ? E('SortExpressions', E('SortExpression', TE('Value', '=' + Y) + (el.sortBy === 'valueDesc' ? T('Direction', 'Descending') : '')))
          : '';
    const topN =
      el.topN > 0
        ? E('Filters', E('Filter', TE('FilterExpression', '=' + Y) + T('Operator', 'TopN') + E('FilterValues', E('FilterValue', String(el.topN), { DataType: 'Integer' }))))
        : '';
    const catMember = E(
      'ChartMember',
      EN('Group', catGroup, E('GroupExpressions', TE('GroupExpression', '=' + cat)) + topN) + sort + TE('Label', '=' + cat),
    );
    let seriesMember = E('ChartMember', TE('Label', el.title || 'Value'));
    if (el.series.trim()) {
      const ser = this.tryVb(el.series, s, `Chart ${el.name} series`);
      if (ser) seriesMember = E('ChartMember', EN('Group', this.uniq(name + '_Series'), E('GroupExpressions', TE('GroupExpression', '=' + ser))) + TE('Label', '=' + ser));
    }
    const [type, subtype] =
      el.chartType === 'bar' ? ['Bar', 'Plain'] : el.chartType === 'line' ? ['Line', 'Plain'] : el.chartType === 'area' ? ['Area', 'Plain'] : el.chartType === 'pie' ? ['Shape', 'Pie'] : el.chartType === 'doughnut' ? ['Shape', 'Doughnut'] : ['Column', 'Plain'];
    const point = E(
      'ChartDataPoint',
      E('ChartDataPointValues', TE('Y', '=' + Y)) +
        E('ChartDataLabel', E('Style', T('Format', el.valueFormat)) + T('Visible', el.showLabels ? 'true' : 'false')) +
        E('Style', '') +
        E('ChartMarker', E('Style', '')) +
        T('DataElementOutput', 'Output'),
    );
    const series = EN(
      'ChartSeries',
      this.uniq(name + '_Values'),
      E('ChartDataPoints', point) + T('Type', type) + T('Subtype', subtype) + E('Style', '') + T('ValueAxisName', 'Primary') + T('CategoryAxisName', 'Primary'),
    );
    const axis = (title = '') => EN('ChartAxis', 'Primary', E('Style', T('FontSize', '8pt')) + E('ChartAxisTitle', TE('Caption', title)) + E('ChartMajorGridLines', T('Enabled', 'False')));
    const palette = el.palette
      .split(',')
      .map((c) => color(c.trim()))
      .filter((c): c is string => !!c);
    return EN(
      'Chart',
      name,
      E('ChartCategoryHierarchy', E('ChartMembers', catMember)) +
        E('ChartSeriesHierarchy', E('ChartMembers', seriesMember)) +
        E('ChartData', E('ChartSeriesCollection', series)) +
        E('ChartAreas', EN('ChartArea', 'Default', E('ChartCategoryAxes', axis()) + E('ChartValueAxes', axis()) + E('Style', ''))) +
        E('ChartLegends', EN('ChartLegend', 'Default', T('Hidden', el.showLegend ? 'false' : 'true') + E('Style', T('FontSize', '8pt')))) +
        (el.title ? E('ChartTitles', EN('ChartTitle', 'Default', TE('Caption', el.title) + E('Style', T('FontSize', '11pt') + T('FontWeight', 'Bold')))) : '') +
        (palette.length ? T('Palette', 'Custom') + E('ChartCustomPaletteColors', palette.map((c) => TE('ChartCustomPaletteColor', c)).join('')) : T('Palette', 'BrightPastel')) +
        T('DataSetName', ic.dataset) +
        geom(g) +
        T('ZIndex', z) +
        (hidden ? E('Visibility', T('Hidden', hidden)) : '') +
        E('Style', NO_BORDER + T('BackgroundColor', color(st.backColor) ?? '#FFFFFF')),
    );
  }

  private crosstab(el: CrosstabElement, ic: ItemCtx, g: Geom, z: number, hidden: string | null, st: ResolvedStyle): string {
    if (!ic.dataset || !ic.scope.fields) {
      this.warn(`Cross tab "${el.name}" has no data source here — left out.`);
      return '';
    }
    const s = { ...ic.scope, bare: null, agg: null };
    const rowE = el.rowField.trim() ? this.tryVb(el.rowField, s, `Cross tab ${el.name} rows`) : null;
    const colE = el.columnField.trim() ? this.tryVb(el.columnField, s, `Cross tab ${el.name} columns`) : null;
    if (!rowE || !colE) {
      this.warn(`Cross tab "${el.name}" needs row and column fields — left out.`);
      return '';
    }
    const val = el.valueField.trim() ? this.tryVb(el.valueField, s, `Cross tab ${el.name} value`) : null;
    const F = el.aggregate === 'none' ? 'Sum' : AGG_NAME[el.aggregate];
    const cellV = val ? `=${F}(${val})` : '=CountRows()';
    const name = this.uniq(el.name || 'CrossTab');
    const hdr: ResolvedStyle = { ...st, bold: true, backColor: el.headerBackColor || st.backColor, textAlign: 'center', vAlign: 'middle', borders: st.borders || 'tlbr' };
    const tot: ResolvedStyle = { ...st, bold: true, backColor: el.totalBackColor || st.backColor, textAlign: 'right', vAlign: 'middle', borders: st.borders || 'tlbr' };
    const vst: ResolvedStyle = { ...st, textAlign: 'right', vAlign: 'middle', borders: st.borders || 'tlbr' };
    const rhst: ResolvedStyle = { ...hdr, textAlign: 'left' };
    const cell = (p: string, value: string, cs: ResolvedStyle, format = '') => E('CellContents', this.textbox(this.uniq(`${name}_${p}`), null, value, cs, NO_RULES, { format, canGrow: true }));
    const rh = mm(el.rowHeight);
    const cols = [el.cellWidth, ...(el.showRowTotals ? [el.cellWidth] : [])];
    const bodyRow = (p: string, cs: ResolvedStyle) =>
      E('TablixRow', T('Height', rh) + E('TablixCells', cols.map((_, i) => E('TablixCell', cell(`${p}${i}`, cellV, i ? tot : cs, el.format))).join('')));
    const rows = [bodyRow('v', vst), ...(el.showColumnTotals ? [bodyRow('t', tot)] : [])];
    const colMembers =
      E(
        'TablixMember',
        EN('Group', this.uniq(name + '_Columns'), E('GroupExpressions', TE('GroupExpression', '=' + colE))) +
          E('SortExpressions', E('SortExpression', TE('Value', '=' + colE))) +
          E('TablixHeader', T('Size', rh) + cell('colhead', '=' + colE, hdr)),
      ) + (el.showRowTotals ? E('TablixMember', E('TablixHeader', T('Size', rh) + cell('coltotal', 'Total', hdr)) + T('KeepWithGroup', 'Before')) : '');
    const rowMembers =
      E(
        'TablixMember',
        EN('Group', this.uniq(name + '_Rows'), E('GroupExpressions', TE('GroupExpression', '=' + rowE))) +
          E('SortExpressions', E('SortExpression', TE('Value', '=' + rowE))) +
          E('TablixHeader', T('Size', mm(el.rowHeaderWidth)) + cell('rowhead', '=' + rowE, rhst)),
      ) + (el.showColumnTotals ? E('TablixMember', E('TablixHeader', T('Size', mm(el.rowHeaderWidth)) + cell('rowtotal', 'Grand Total', { ...tot, textAlign: 'left' })) + T('KeepWithGroup', 'Before')) : '');
    const corner = E('TablixCorner', E('TablixCornerRows', E('TablixCornerRow', E('TablixCornerCell', cell('corner', el.corner, hdr)))));
    const height = el.rowHeight * (2 + (el.showColumnTotals ? 1 : 0));
    const width = el.rowHeaderWidth + el.cellWidth * cols.length;
    return EN(
      'Tablix',
      name,
      corner +
        E('TablixBody', E('TablixColumns', cols.map((w) => E('TablixColumn', T('Width', mm(w)))).join('')) + E('TablixRows', rows.join(''))) +
        E('TablixColumnHierarchy', E('TablixMembers', colMembers)) +
        E('TablixRowHierarchy', E('TablixMembers', rowMembers)) +
        T('DataSetName', ic.dataset) +
        geom({ x: g.x, y: g.y, w: width, h: height }) +
        T('ZIndex', z) +
        (hidden ? E('Visibility', T('Hidden', hidden)) : '') +
        E('Style', NO_BORDER),
    );
  }

  // ---------------------------------------------------------------- bands
  isEmptyBand(b: Band) {
    return !b.backColor && !b.evenRowColor && !this.r.elements.some((e) => e.bandId === b.id);
  }
  private async bandItems(band: Band, ic: ItemCtx): Promise<string> {
    const els = this.r.elements.filter((e) => e.bandId === band.id);
    const parts: string[] = [];
    for (let i = 0; i < els.length; i++) parts.push(await this.item(els[i], ic, i));
    return parts.join('');
  }
  async bandRect(band: Band, ic: ItemCtx, o: { name: string; geom?: Geom | null; bg?: string | null; pageBreak?: string | null }): Promise<string> {
    const items = await this.bandItems(band, ic);
    const bg = o.bg !== undefined ? o.bg : color(band.backColor);
    return EN(
      'Rectangle',
      this.uniq(o.name),
      (items ? E('ReportItems', items) : '') +
        (band.keepTogether ? T('KeepTogether', 'true') : '') +
        (o.pageBreak ? E('PageBreak', T('BreakLocation', o.pageBreak)) : '') +
        geom(o.geom ?? null) +
        E('Style', NO_BORDER + T('BackgroundColor', bg)),
    );
  }
  private bandHidden(band: Band, s: Scope): string | null {
    if (!band.visibleExpr?.trim()) return null;
    const v = this.tryVb(band.visibleExpr, s, 'Band visible expression');
    return v ? `=Not CBool(${v})` : null;
  }
  async bandRow(band: Band, s: Scope, dataset: string, name: string, evenScope?: string): Promise<RowSpec> {
    let bg: string | null | undefined;
    if (evenScope && band.evenRowColor) {
      bg = `=IIf(RowNumber(${q(evenScope)}) Mod 2 = 0, ${q(color(band.evenRowColor) ?? band.evenRowColor)}, ${q(color(band.backColor) ?? 'Transparent')})`;
    }
    const cell = await this.bandRect(band, { scope: s, where: 'cell', dataset }, { name, bg });
    return { height: band.height, cell, hidden: this.bandHidden(band, { ...s, bare: null }), keepTogether: band.keepTogether, repeat: !!band.repeatEveryPage };
  }

  sortXml(sorts: { expression: string; dir: 'asc' | 'desc' }[], s: Scope): string {
    const items = sorts
      .filter((x) => x.expression.trim())
      .map((x) => {
        const v = this.tryVb(x.expression, s, 'Sort');
        return v ? E('SortExpression', TE('Value', '=' + v) + (x.dir === 'desc' ? T('Direction', 'Descending') : '')) : '';
      })
      .filter(Boolean);
    return items.length ? E('SortExpressions', items.join('')) : '';
  }

  /** a one-column list tablix: static rows before, group levels, details rows, static rows after */
  listTablix(o: {
    name: string;
    dataset: string;
    top: number;
    groups: GroupLevel[];
    before: RowSpec[];
    details: RowSpec[];
    after: RowSpec[];
    detailsSort: string;
    detailBreak?: string | null;
    hidden?: string | null;
  }): { xml: string; height: number } {
    const rows: RowSpec[] = [];
    const props = (r: RowSpec, keepWith?: string) =>
      (keepWith ? T('KeepWithGroup', keepWith) : '') +
      (r.repeat && keepWith ? T('RepeatOnNewPage', 'true') : '') +
      (r.keepTogether ? T('KeepTogether', 'true') : '') +
      (r.hidden ? E('Visibility', T('Hidden', r.hidden)) : '');
    const staticMember = (r: RowSpec, keepWith?: string) => {
      rows.push(r);
      return E('TablixMember', props(r, keepWith));
    };
    const emptyCell = EN('Rectangle', this.uniq(o.name + '_Empty'), E('Style', NO_BORDER));
    const level = (i: number): string => {
      if (i >= o.groups.length) {
        const det = o.details.length ? o.details : [{ height: 2, cell: emptyCell, hidden: 'true' }];
        const group = EN('Group', this.uniq(o.name + '_Details'), o.detailBreak ? E('PageBreak', T('BreakLocation', o.detailBreak)) : '');
        if (det.length === 1) {
          rows.push(det[0]);
          return E('TablixMember', group + o.detailsSort + props(det[0]));
        }
        return E('TablixMember', group + o.detailsSort + E('TablixMembers', det.map((d) => staticMember(d)).join('')));
      }
      const gl = o.groups[i];
      const head = gl.header ? staticMember(gl.header, 'After') : '';
      const inner = level(i + 1);
      const foot = gl.footer ? staticMember(gl.footer, 'Before') : '';
      const sort = gl.sort !== 'none' ? E('SortExpressions', E('SortExpression', TE('Value', '=' + gl.expr) + (gl.sort === 'desc' ? T('Direction', 'Descending') : ''))) : '';
      return E(
        'TablixMember',
        EN('Group', gl.name, E('GroupExpressions', TE('GroupExpression', '=' + gl.expr)) + (gl.pageBreak ? E('PageBreak', T('BreakLocation', gl.pageBreak)) : '')) +
          sort +
          E('TablixMembers', head + inner + foot),
      );
    };
    const before = o.before.map((r) => staticMember(r, 'After')).join('');
    const middle = level(0);
    const after = o.after.map((r) => staticMember(r, 'Before')).join('');
    const height = rows.reduce((a, r) => a + r.height, 0);
    const body = E(
      'TablixBody',
      E('TablixColumns', E('TablixColumn', T('Width', mm(this.cw)))) +
        E('TablixRows', rows.map((r) => E('TablixRow', T('Height', mm(r.height)) + E('TablixCells', E('TablixCell', E('CellContents', r.cell))))).join('')),
    );
    const xml = EN(
      'Tablix',
      o.name,
      body +
        E('TablixColumnHierarchy', E('TablixMembers', E('TablixMember', ''))) +
        E('TablixRowHierarchy', E('TablixMembers', before + middle + after)) +
        T('DataSetName', o.dataset) +
        T('Top', mm(o.top)) +
        T('Left', '0mm') +
        T('Height', mm(height)) +
        T('Width', mm(this.cw)) +
        (o.hidden ? E('Visibility', T('Hidden', o.hidden)) : '') +
        E('Style', NO_BORDER),
    );
    return { xml, height };
  }

  bodyScope(set: DataSetInfo | null, fn: 'First' | 'Last'): Scope {
    return this.mkScope(set?.fields ?? null, { agg: set?.name ?? null, bare: set ? { fn, scope: set.name } : null, run: { report: set?.name ?? null, group: set?.name ?? null } });
  }

  // ---------------------------------------------------------------- sections (detail reports)
  async sectionBlock(d: DetailReportDef, top: number, inSub: boolean): Promise<{ items: string[]; height: number }> {
    const r = this.r;
    if (!d.dataSourceId || !r.dataSources.some((x) => x.id === d.dataSourceId)) {
      this.warn(`Section "${d.name}" has no data source — left out.`);
      return { items: [], height: 0 };
    }
    const fm = this.fieldMap(d.dataSourceId);
    const fscope = this.mkScope(fm);
    const filters: string[] = [];
    if (d.filter.trim()) {
      const v = this.tryVb(d.filter, fscope, `Section "${d.name}" filter`);
      if (v) filters.push(boolFilter(v));
    }
    if (inSub)
      for (const k of this.keyFilters) {
        const cv = this.tryVb(keyExpr(k.child), fscope, `Section "${d.name}" link field`);
        if (cv)
          filters.push(
            E('Filter', TE('FilterExpression', `=UCase(Trim(CStr(${cv})))`) + T('Operator', 'Equal') + E('FilterValues', TE('FilterValue', `=UCase(Trim(CStr(Parameters!${k.param}.Value)))`))),
          );
      }
    const set = this.dataset(d.dataSourceId, filters);
    const tName = this.uniq(ident(d.name, 'Section'));
    const band = (t: Band['type']) => r.bands.find((b) => b.type === t && b.detailReportId === d.id && b.visible);
    const h = band('drHeader');
    const det = band('drDetail');
    const f = band('drFooter');
    const onceKids = childDetailReports(r, d.id, 'once');
    const rowKids = childDetailReports(r, d.id, 'perRow');
    const before: RowSpec[] = [];
    const after: RowSpec[] = [];
    const details: RowSpec[] = [];
    if (h) before.push(await this.bandRow(h, this.mkScope(fm, { bare: { fn: 'First', scope: null }, run: { report: tName, group: tName } }), set.name, tName + '_Header'));
    const dscope = this.mkScope(fm, { agg: tName, rowScope: tName, run: { report: tName, group: tName } });
    if (det && !this.isEmptyBand(det)) details.push(await this.bandRow(det, dscope, set.name, tName + '_Detail', tName));
    for (const c of rowKids) details.push(await this.subreportRow(c, dscope));
    if (f && !onceKids.length) after.push(await this.bandRow(f, this.mkScope(fm, { bare: { fn: 'Last', scope: null }, run: { report: tName, group: tName } }), set.name, tName + '_Footer'));
    const t = this.listTablix({
      name: tName,
      dataset: set.name,
      top,
      groups: [],
      before,
      details,
      after,
      detailsSort: this.sortXml(d.sort, this.mkScope(fm)),
      hidden: inSub ? `=CountRows(${q(set.name)}) = 0` : null,
    });
    const items = [t.xml];
    let y = top + t.height;
    for (const c of onceKids) {
      const b = await this.sectionBlock(c, y, false);
      items.push(...b.items);
      y += b.height;
    }
    if (f && onceKids.length) {
      items.push(await this.bandRect(f, { scope: this.bodyScope(set, 'Last'), where: 'body', dataset: set.name }, { name: tName + '_Footer', geom: { x: 0, y, w: this.cw, h: f.height } }));
      y += f.height;
    }
    return { items, height: y - top };
  }

  /** a section printed for every parent row -> a subreport (separate .rdl) with the link values as parameters */
  async subreportRow(d: DetailReportDef, parent: Scope): Promise<RowSpec> {
    const child = new RdlDoc(this.r, this.o, this.g);
    child.hideReportParams = true;
    const subName = uniqFile(this.g, `${this.o.baseName}_${ident(d.name, 'Section')}`);
    const passes: { name: string; value: string }[] = [];
    const pscope: Scope = { ...parent, bare: null };
    d.keys
      .filter((k) => k.master.trim() && k.child.trim())
      .forEach((k, i) => {
        const pn = child.addParam(`Key${i + 1}`, 'String');
        const v = this.tryVb(keyExpr(k.master), pscope, `Section "${d.name}" link field`);
        passes.push({ name: pn, value: v ? '=' + v : '=Nothing' });
        child.keyFilters.push({ child: k.child, param: pn });
      });
    const masters = new Map<string, string>();
    child.masterFn = (field: string) => {
      const k = field.toLowerCase();
      let pn = masters.get(k);
      if (!pn) {
        const info = parent.fields?.get(k);
        pn = child.addParam('Master_' + ident(field, 'Field'), RDL_TYPE[info?.type ?? 'any'] ?? 'String');
        masters.set(k, pn);
        const v = this.tryVb(`[${field}]`, pscope, `Section "${d.name}" [Master.${field}]`);
        passes.push({ name: pn, value: v ? '=' + v : '=Nothing' });
      }
      return pn;
    };
    const blk = await child.sectionBlock(d, 0, true);
    const xml = child.toXml(blk.items.join(''), blk.height, '', '');
    this.g.files.push({ name: subName + '.rdl', xml: prettyXml(xml) });
    for (const p of this.r.parameters) {
      const pn = this.paramName(p.name);
      passes.push({ name: child.paramName(p.name), value: `=Parameters!${pn}.Value` });
    }
    const height = Math.max(
      12,
      this.r.bands.filter((b) => b.detailReportId === d.id && b.visible).reduce((a, b) => a + b.height, 0),
    );
    const sub = EN(
      'Subreport',
      this.uniq('Sub_' + ident(d.name, 'Section')),
      T('ReportName', subName) +
        (passes.length ? E('Parameters', passes.map((p) => EN('Parameter', p.name, TE('Value', p.value))).join('')) : '') +
        T('KeepTogether', 'true') +
        E('Style', NO_BORDER),
    );
    return { height, cell: sub };
  }

  // ---------------------------------------------------------------- main report
  async buildMain(): Promise<string> {
    const r = this.r;
    const cw = this.cw;
    const mainId = r.dataSourceId && r.dataSources.some((d) => d.id === r.dataSourceId) ? r.dataSourceId : null;
    let set: DataSetInfo | null = null;
    if (mainId) {
      const fm = this.fieldMap(mainId);
      const filters: string[] = [];
      if (r.filter.trim()) {
        const v = this.tryVb(r.filter, this.mkScope(fm), 'Report filter');
        if (v) filters.push(boolFilter(v));
      }
      set = this.dataset(mainId, filters);
    }
    const items: string[] = [];
    let y = 0;
    const vis = (t: Band['type']) => r.bands.find((b) => b.type === t && b.visible);
    const rh = vis('reportHeader');
    if (rh) {
      items.push(
        await this.bandRect(rh, { scope: this.bodyScope(set, 'First'), where: 'body', dataset: set?.name ?? null }, { name: 'ReportHeader', geom: { x: 0, y, w: cw, h: rh.height }, pageBreak: rh.pageBreakAfter ? 'End' : null }),
      );
      y += rh.height;
    }
    // main list: groups + detail (+ sections printed for every main row)
    const det = vis('detail');
    const rowKids = childDetailReports(r, null, 'perRow');
    if (set) {
      const fm = set.fields;
      const tName = this.uniq('MainList');
      const groups: GroupLevel[] = [];
      for (let i = 0; i < r.groups.length; i++) {
        const gdef = r.groups[i];
        const gName = this.uniq('Group' + (i + 1) + (gdef.expression ? '_' + ident(gdef.expression.replace(/[[\]]/g, ''), 'G') : ''));
        const gs = (fn: 'First' | 'Last') => this.mkScope(fm, { bare: { fn, scope: null }, rowScope: gName, run: { report: tName, group: gName } });
        const hb = r.bands.find((b) => b.type === 'groupHeader' && b.groupId === gdef.id && b.visible);
        const fb = r.bands.find((b) => b.type === 'groupFooter' && b.groupId === gdef.id && b.visible);
        const ge = gdef.expression.trim() ? this.tryVb(gdef.expression, this.mkScope(fm), `Group ${i + 1}`) : null;
        const brk = [hb?.pageBreakBefore ? 'Start' : '', fb?.pageBreakAfter ? 'End' : ''].filter(Boolean);
        groups.push({
          name: gName,
          expr: ge ?? '1',
          sort: gdef.sort,
          header: hb ? await this.bandRow(hb, gs('First'), set.name, gName + '_Header') : undefined,
          footer: fb ? await this.bandRow(fb, gs('Last'), set.name, gName + '_Footer') : undefined,
          pageBreak: brk.length === 2 ? 'StartAndEnd' : (brk[0] ?? null),
        });
      }
      const inner = groups.length ? groups[groups.length - 1].name : tName;
      const dscope = this.mkScope(fm, { agg: inner, rowScope: inner, run: { report: tName, group: inner } });
      const details: RowSpec[] = [];
      if (det && !this.isEmptyBand(det)) details.push(await this.bandRow(det, dscope, set.name, 'Detail', inner));
      for (const c of rowKids) details.push(await this.subreportRow(c, dscope));
      if (groups.length || details.length) {
        const t = this.listTablix({
          name: tName,
          dataset: set.name,
          top: y,
          groups,
          before: [],
          details,
          after: [],
          detailsSort: this.sortXml(r.sort, this.mkScope(fm)),
          detailBreak: det?.pageBreakBefore ? 'Start' : det?.pageBreakAfter ? 'End' : null,
        });
        items.push(t.xml);
        y += t.height;
      }
    } else if (det && !this.isEmptyBand(det)) {
      if (r.elements.some((e) => e.bandId === det.id && 'expression' in e && (e as { expression: string }).expression)) this.warn('The Detail band uses fields but the report has no main data source.');
      items.push(await this.bandRect(det, { scope: this.bodyScope(null, 'First'), where: 'body', dataset: null }, { name: 'Detail', geom: { x: 0, y, w: cw, h: det.height } }));
      y += det.height;
    }
    for (const d of childDetailReports(r, null, 'once')) {
      const b = await this.sectionBlock(d, y, false);
      items.push(...b.items);
      y += b.height;
    }
    const rf = vis('reportFooter');
    if (rf) {
      items.push(
        await this.bandRect(rf, { scope: this.bodyScope(set, 'Last'), where: 'body', dataset: set?.name ?? null }, { name: 'ReportFooter', geom: { x: 0, y, w: cw, h: rf.height }, pageBreak: rf.pageBreakBefore ? 'Start' : null }),
      );
      y += rf.height;
    }
    // page header / footer
    const pageSection = async (t: 'pageHeader' | 'pageFooter') => {
      const b = vis(t);
      if (!b) return '';
      const scope = { ...this.bodyScope(set, 'First'), page: true };
      const its = await this.bandItems(b, { scope, where: 'page', dataset: set?.name ?? null });
      return E(
        t === 'pageHeader' ? 'PageHeader' : 'PageFooter',
        T('Height', mm(b.height)) +
          T('PrintOnFirstPage', b.printOnFirstPage === false ? 'false' : 'true') +
          T('PrintOnLastPage', b.printOnLastPage === false ? 'false' : 'true') +
          (its ? E('ReportItems', its) : '') +
          E('Style', NO_BORDER + T('BackgroundColor', color(b.backColor))),
      );
    };
    const header = await pageSection('pageHeader');
    const footer = await pageSection('pageFooter');
    if (r.page.autoHeight) this.warn('Roll paper (auto height) is not available in RDL — the report uses the page height set in Page Setup.');
    const wm = await this.watermark();
    return this.toXml(items.join(''), y, header, footer, wm);
  }

  private async watermark(): Promise<string> {
    const wm = this.r.watermark;
    if (!wm?.enabled || (!wm.text && !wm.image)) return '';
    try {
      const w = this.r.page.width;
      const h = this.r.page.height;
      const image = wm.image ? await toDataUrl(wm.image) : '';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${watermarkSvg({ ...wm, image }, w, h)}</svg>`;
      const c = await svgToCanvas(svg, w, h, 1);
      const png = c.toDataURL('image/png');
      const name = this.embed('image/png', png.slice(png.indexOf(',') + 1));
      if (!wm.behind) this.warn('The watermark is exported as a page background image (always behind the content).');
      return E('BackgroundImage', T('Source', 'Embedded') + TE('Value', name) + T('BackgroundRepeat', 'Clip') + T('Position', 'Center'));
    } catch {
      this.warn('The watermark could not be exported.');
      return '';
    }
  }

  // ---------------------------------------------------------------- document
  private paramsXml(): string {
    const list: string[] = [];
    for (const { rdl, def: p } of this.params.values()) {
      const type = RDL_TYPE[p.type] ?? 'String';
      let dv = '';
      const raw = (p.defaultValue ?? '').trim();
      if (raw) {
        let v: string = raw;
        if (/[([?]/.test(raw) && !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
          const x = this.tryVb(raw, this.mkScope(null, { master: null }), `Default value of parameter ${p.name}`);
          v = x ? '=' + x : raw;
        }
        dv = E('DefaultValue', E('Values', TE('Value', v)));
      }
      const values = (p.values ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const valid = values.length ? E('ValidValues', E('ParameterValues', values.map((v) => E('ParameterValue', TE('Value', v) + TE('Label', v))).join(''))) : '';
      list.push(
        EN(
          'ReportParameter',
          rdl,
          T('DataType', type) +
            T('Nullable', 'true') +
            dv +
            (type === 'String' ? T('AllowBlank', 'true') : '') +
            TE('Prompt', p.label || p.name) +
            valid +
            (this.hideReportParams || !p.visible ? T('Hidden', 'true') : ''),
        ),
      );
    }
    for (const x of this.extraParams) list.push(EN('ReportParameter', x.name, T('DataType', x.type) + T('Nullable', 'true') + (x.type === 'String' ? T('AllowBlank', 'true') : '') + TE('Prompt', x.name) + T('Hidden', 'true')));
    return list.length ? E('ReportParameters', list.join('')) : '';
  }

  toXml(bodyItems: string, bodyHeight: number, header: string, footer: string, pageBg = ''): string {
    const r = this.r;
    const p = r.page;
    // data sets first: building them registers their data sources
    const sets = [...this.sets.values()].map((s) => this.datasetXml(s)).join('');
    const sources = [...this.sources.values()].map((s) => s.xml).join('');
    const images = [...this.images.values()].map((im) => EN('EmbeddedImage', im.name, T('MIMEType', im.mime) + TE('ImageData', im.data))).join('');
    const page = E(
      'Page',
      header +
        footer +
        T('PageHeight', mm(p.height)) +
        T('PageWidth', mm(p.width)) +
        (p.autoHeight ? T('InteractiveHeight', '0mm') : '') +
        T('LeftMargin', mm(p.margins.left)) +
        T('RightMargin', mm(p.margins.right)) +
        T('TopMargin', mm(p.margins.top)) +
        T('BottomMargin', mm(p.margins.bottom)) +
        E('Style', pageBg),
    );
    const section = E(
      'ReportSections',
      E('ReportSection', E('Body', (bodyItems ? E('ReportItems', bodyItems) : '') + T('Height', mm(Math.max(bodyHeight, 2))) + E('Style', NO_BORDER)) + T('Width', mm(this.cw)) + page),
    );
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<Report xmlns="${RDL_NS}" xmlns:rd="${RD_NS}">` +
      T('Description', r.description) +
      T('Author', r.author) +
      T('AutoRefresh', '0') +
      (sources ? E('DataSources', sources) : '') +
      (sets ? E('DataSets', sets) : '') +
      section +
      this.paramsXml() +
      (images ? E('EmbeddedImages', images) : '') +
      T('Language', r.locale || 'en-US') +
      T('ConsumeContainerWhitespace', 'true') +
      '<rd:ReportUnitType>Mm</rd:ReportUnitType>' +
      `<rd:ReportID>${uuid()}</rd:ReportID>` +
      '</Report>'
    );
  }
}

// ------------------------------------------------------------------ helpers
function geom(g: Geom | null): string {
  return g ? T('Top', mm(g.y)) + T('Left', mm(g.x)) + T('Height', mm(g.h)) + T('Width', mm(g.w)) : '';
}
function boolFilter(v: string) {
  return E('Filter', TE('FilterExpression', `=CBool(${v})`) + T('Operator', 'Equal') + E('FilterValues', E('FilterValue', 'true', { DataType: 'Boolean' })));
}
/** a link key is a field name, or an expression when it contains [ ( ? or quotes */
function keyExpr(k: string) {
  return /[[(?'"]/.test(k) ? k : `[${k.trim()}]`;
}
function uuid() {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
  }
}
function uniqFile(g: Shared, base: string) {
  let n = base;
  let i = 2;
  while (g.fileNames.has(n.toLowerCase())) n = `${base}_${i++}`;
  g.fileNames.add(n.toLowerCase());
  return n;
}
/** Replace @name / :name markers outside strings and comments (fn returns null to keep a marker). */
function rewriteMarkers(sql: string, fn: (name: string) => string | null): string {
  let out = '';
  let i = 0;
  const s = sql;
  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    let j = -1;
    if (two === '--') {
      const k = s.indexOf('\n', i);
      j = k < 0 ? s.length : k;
    } else if (two === '/*') {
      const k = s.indexOf('*/', i + 2);
      j = k < 0 ? s.length : k + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      j = i + 1;
      while (j < s.length && !(s[j] === end && s[j + 1] !== end)) j += s[j] === end ? 2 : 1;
      j = Math.min(s.length, j + 1);
    }
    if (j > i) {
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if ((c === '@' || c === ':') && !/[\w:@$]/.test(s[i - 1] ?? '') && s[i + 1] !== c) {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(i + 1));
      const rep = m ? fn(m[0]) : null;
      if (m && rep !== null) {
        out += rep;
        i += 1 + m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Convert a report into RDL files (the report + one file per "for every row" section). */
export async function exportRdl(r: ReportDef, o: RdlOptions): Promise<RdlResult> {
  const g: Shared = { files: [], warnings: [], fileNames: new Set([o.baseName.toLowerCase()]) };
  const doc = new RdlDoc(r, o, g);
  let xml = prettyXml(await doc.buildMain());
  if (o.embedDefinition) xml = embedDefinition(xml, r);
  const files = [{ name: o.baseName + '.rdl', xml }, ...g.files];
  if (g.files.length) g.warnings.unshift(`Sections printed for every row are subreports: keep the ${files.length} .rdl files together in one folder (or upload them to the same report server folder).`);
  if (r.dataSources.some((d) => d.kind === 'sql')) g.warnings.push('Database passwords are not stored in the RDL — enter the credentials in Report Builder or on the report server.');
  const web = [...usedFamilies(r)].filter((f) => isGoogleFont(f, r.fonts ?? []));
  if (web.length) g.warnings.push(`Google fonts used (${web.join(', ')}): install them on the report server and on the PCs that open the report (download from fonts.google.com), otherwise another font is shown.`);
  return { files, warnings: g.warnings };
}
