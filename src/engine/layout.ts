// Element & band layout: turns report elements into drawing primitives.
import type {
  Band,
  BandType,
  BarcodeElement,
  ChartElement,
  CheckboxElement,
  CrosstabElement,
  ImageElement,
  LineElement,
  PageInfoElement,
  ReportDef,
  ReportElement,
  ResolvedStyle,
  Row,
  ShapeElement,
  StyleProps,
  SummaryFunc,
  SummaryRunning,
  TableElement,
  TextElement,
} from '../model/types';
import { resolveStyle } from '../model/defaults';
import { cellOwners, effectiveSpan } from '../model/table';
import type { CellInfo, Prim, PText } from './doc';
import { shiftPrim, shiftCell } from './doc';
import { aggregateValues, compareValues, evalExpr, interpolate, truthy, usesPageInfo, type EvalContext } from './expression';
import { compositeFormat, defaultToString, formatValue, isDate } from './format';
import { fontMetrics, lineHeight, textWidth, wrapText, type FontSpec } from './measure';
import { encodeCode128, encodeCode39, encodeEan13, encodeQr, ean13Digits } from './barcode';
import { buildChartData, chartSvg } from './chart';

export interface LayoutEnv {
  report: ReportDef;
  ctx: EvalContext;
  design: boolean;
  bandType: BandType;
  /** page header/footer: rendered once page numbers are known */
  pageScoped?: boolean;
  running?: { group: Row[]; page: Row[]; report: Row[] };
}

export interface ElementLayout {
  prims: Prim[];
  height: number;
  cells: CellInfo[];
  hidden?: boolean;
  bookmark?: string;
}

export const fontOf = (s: ResolvedStyle): FontSpec => ({ family: s.fontFamily, size: s.fontSize, bold: s.bold, italic: s.italic });
const fmtOpts = (env: LayoutEnv) => ({ locale: env.report.locale || 'en-US', currency: env.report.currency || 'USD' });

// ------------------------------------------------------------------ text box
export interface TextBoxOpts {
  wordWrap: boolean;
  canGrow: boolean;
  canShrink: boolean;
  noBorders?: boolean;
  noBackground?: boolean;
}

export function borderPrims(st: ResolvedStyle, w: number, h: number): Prim[] {
  const b = st.borders || '';
  if (!b || st.borderWidth <= 0) return [];
  const out: Prim[] = [];
  const base = { k: 'line' as const, color: st.borderColor, width: st.borderWidth, ls: st.borderStyle };
  if (b.includes('t')) out.push({ ...base, x1: 0, y1: 0, x2: w, y2: 0 });
  if (b.includes('b')) out.push({ ...base, x1: 0, y1: h, x2: w, y2: h });
  if (b.includes('l')) out.push({ ...base, x1: 0, y1: 0, x2: 0, y2: h });
  if (b.includes('r')) out.push({ ...base, x1: w, y1: 0, x2: w, y2: h });
  return out;
}

export function textBox(text: string, w: number, h: number, st: ResolvedStyle, o: TextBoxOpts): { prims: Prim[]; height: number } {
  const font = fontOf(st);
  const pad = st.padding;
  const innerW = Math.max(1, w - 2 * pad);
  const paras = text === '' ? [] : String(text).replace(/\r\n?/g, '\n').split('\n');
  let lines: { s: string; last: boolean }[] = [];
  for (const p of paras) {
    const ls = wrapText(p, font, innerW, o.wordWrap);
    ls.forEach((s, i) => lines.push({ s, last: i === ls.length - 1 }));
  }
  const lh = lineHeight(font);
  const need = lines.length * lh + 2 * pad;
  let height = h;
  if (o.canGrow && need > h + 0.5) height = Math.ceil(need);
  if (o.canShrink && need < h) height = lines.length ? Math.ceil(need) : 0;
  if (!o.canGrow) {
    const maxLines = Math.max(1, Math.floor((height - 2 * pad + 0.5) / lh));
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  }
  const prims: Prim[] = [];
  if (height <= 0) return { prims, height: 0 };
  if (st.backColor && !o.noBackground) prims.push({ k: 'rect', x: 0, y: 0, w, h: height, fill: st.backColor });
  const textH = lines.length * lh;
  let vy = pad;
  if (st.vAlign === 'middle') vy = (height - textH) / 2;
  else if (st.vAlign === 'bottom') vy = height - pad - textH;
  const m = fontMetrics(font);
  const asc = (lh - (m.asc + m.desc)) / 2 + m.asc;
  lines.forEach((ln, i) => {
    const y = vy + i * lh;
    const base: Omit<PText, 'x' | 'w' | 'text' | 'align'> = {
      k: 'text',
      y,
      h: lh,
      asc,
      font,
      color: st.color,
      underline: st.underline || undefined,
      strike: st.strike || undefined,
    };
    if (st.textAlign === 'justify' && !ln.last) {
      const parts = ln.s.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        const widths = parts.map((p) => textWidth(p, font));
        const gap = (innerW - widths.reduce((a, b) => a + b, 0)) / (parts.length - 1);
        let x = pad;
        parts.forEach((p, j) => {
          prims.push({ ...base, x, w: widths[j] + 1, text: p, align: 'left' });
          x += widths[j] + gap;
        });
        return;
      }
    }
    prims.push({ ...base, x: pad, w: innerW, text: ln.s, align: st.textAlign === 'justify' ? 'left' : st.textAlign });
  });
  if (!o.noBorders) prims.push(...borderPrims(st, w, height));
  return { prims, height };
}

// ------------------------------------------------------------------ helpers
function applyRules(el: ReportElement, env: LayoutEnv): { hidden: boolean; styles: StyleProps[] } {
  if (env.design) return { hidden: false, styles: [] };
  if (el.visibleExpr && el.visibleExpr.trim() && !truthy(evalExpr(el.visibleExpr, env.ctx))) return { hidden: true, styles: [] };
  const styles: StyleProps[] = [];
  let hidden = false;
  for (const r of el.formatRules ?? []) {
    if (r.condition && truthy(evalExpr(r.condition, env.ctx))) {
      styles.push(r.style);
      if (r.hide) hidden = true;
    }
  }
  return { hidden, styles };
}

function summaryRows(env: LayoutEnv, running: SummaryRunning): Row[] {
  if (running === 'none' || !env.running) return env.ctx.rows;
  return env.running[running] ?? env.ctx.rows;
}

const FN_NAMES: Record<SummaryFunc, string> = {
  none: '',
  sum: 'Sum',
  count: 'Count',
  avg: 'Avg',
  min: 'Min',
  max: 'Max',
  countDistinct: 'CountDistinct',
  first: 'First',
  last: 'Last',
};

export function designText(text: string, expression: string, summary: SummaryFunc = 'none'): string {
  if (expression) {
    const e = expression.trim();
    if (summary !== 'none') return `${FN_NAMES[summary]}(${e})`;
    return /^\[[^\]]+\]$/.test(e) ? e : e.length > 60 ? e.slice(0, 57) + '...' : e;
  }
  return text;
}

/** Compute display text and raw value for a data-bound text item. */
export function boundValue(
  env: LayoutEnv,
  text: string,
  expression: string,
  format: string,
  summary: SummaryFunc,
  running: SummaryRunning,
  nullText: string,
  ctx: EvalContext = env.ctx,
): { text: string; value: unknown } {
  if (expression && expression.trim()) {
    let v: unknown;
    if (summary && summary !== 'none') {
      const rows = summaryRows(env, running);
      const vals = rows.map((row) => evalExpr(expression, { ...ctx, row }));
      v = aggregateValues(summary.toLowerCase(), vals);
    } else v = evalExpr(expression, ctx);
    const t = v === null || v === undefined || v === '' ? nullText : formatValue(v, format, fmtOpts(env));
    return { text: t, value: v };
  }
  const t = interpolate(text, ctx);
  return { text: format && t && !isNaN(Number(t)) ? formatValue(Number(t), format, fmtOpts(env)) : t, value: t };
}

// ------------------------------------------------------------------ elements
function layoutText(el: TextElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  if (env.design) {
    const r = textBox(designText(el.text, el.expression, el.summaryFunc), el.width, el.height, st, { wordWrap: el.wordWrap && !el.expression, canGrow: false, canShrink: false });
    return { prims: r.prims, height: el.height, cells: [] };
  }
  const src = el.expression || el.text;
  if (!env.pageScoped && usesPageInfo(src)) {
    const ctx = env.ctx;
    return {
      prims: [
        {
          k: 'defer',
          x: 0,
          y: 0,
          w: el.width,
          h: el.height,
          render: (page, pageCount) => {
            const v = boundValue(env, el.text, el.expression, el.format, el.summaryFunc, el.summaryRunning, el.nullText, { ...ctx, page, pageCount });
            return textBox(v.text, el.width, el.height, st, { wordWrap: el.wordWrap, canGrow: false, canShrink: false }).prims;
          },
        },
      ],
      height: el.height,
      cells: [],
    };
  }
  const v = boundValue(env, el.text, el.expression, el.format, el.summaryFunc, el.summaryRunning, el.nullText);
  const r = textBox(v.text, el.width, el.height, st, { wordWrap: el.wordWrap, canGrow: el.canGrow, canShrink: el.canShrink });
  const cells: CellInfo[] =
    r.height > 0
      ? [{ x: 0, y: 0, w: el.width, h: r.height, text: v.text, value: el.expression ? v.value : v.text, bold: st.bold, align: st.textAlign, band: env.bandType, style: st, wrap: el.wordWrap }]
      : [];
  return { prims: r.prims, height: r.height, cells };
}

function boxDecor(st: ResolvedStyle, w: number, h: number, inner: Prim[]): Prim[] {
  const out: Prim[] = [];
  if (st.backColor) out.push({ k: 'rect', x: 0, y: 0, w, h, fill: st.backColor });
  out.push(...inner);
  out.push(...borderPrims(st, w, h));
  return out;
}

function layoutImage(el: ImageElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  let src = el.src;
  if (!env.design && el.expression) {
    const v = evalExpr(el.expression, env.ctx);
    src = v ? String(v) : '';
  }
  const inner: Prim[] = [];
  if (src) inner.push({ k: 'image', x: 0, y: 0, w: el.width, h: el.height, src, sizing: el.sizing });
  else if (env.design) {
    inner.push({ k: 'rect', x: 0, y: 0, w: el.width, h: el.height, fill: '#f3f4f6', stroke: '#cbd5e1', sw: 1, ls: 'dashed' });
    const t = textBox(el.expression ? `[img] ${el.expression}` : 'Picture', el.width, el.height, { ...st, textAlign: 'center', vAlign: 'middle', color: '#64748b', borders: '' }, { wordWrap: true, canGrow: false, canShrink: false });
    inner.push(...t.prims);
  }
  return { prims: boxDecor(st, el.width, el.height, inner), height: el.height, cells: [] };
}

function layoutLine(el: LineElement): ElementLayout {
  const { width: w, height: h } = el;
  let x1 = 0,
    y1 = 0,
    x2 = w,
    y2 = h;
  if (el.direction === 'horizontal') y1 = y2 = h / 2;
  else if (el.direction === 'vertical') x1 = x2 = w / 2;
  else if (el.direction === 'slantUp') {
    y1 = h;
    y2 = 0;
  }
  return { prims: [{ k: 'line', x1, y1, x2, y2, color: el.lineColor, width: el.lineWidth, ls: el.lineStyle }], height: h, cells: [] };
}

function layoutShape(el: ShapeElement): ElementLayout {
  const i = el.lineWidth / 2;
  const w = el.width - el.lineWidth;
  const h = el.height - el.lineWidth;
  const st = { fill: el.fillColor || undefined, stroke: el.lineWidth > 0 ? el.lineColor : undefined, sw: el.lineWidth, ls: el.lineStyle };
  let p: Prim;
  const poly = (pts: number[]): Prim => ({ k: 'poly', pts: pts.map((v, j) => v + i * (j % 2 ? 1 : 1)), closed: true, ...st });
  switch (el.shape) {
    case 'ellipse':
      p = { k: 'ellipse', x: i, y: i, w, h, ...st };
      break;
    case 'roundRect':
      p = { k: 'rect', x: i, y: i, w, h, r: Math.min(el.cornerRadius, w / 2, h / 2), ...st };
      break;
    case 'triangle':
      p = poly([w / 2, 0, w, h, 0, h]);
      break;
    case 'diamond':
      p = poly([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]);
      break;
    case 'arrowRight':
      p = poly([0, h * 0.3, w * 0.6, h * 0.3, w * 0.6, 0, w, h / 2, w * 0.6, h, w * 0.6, h * 0.7, 0, h * 0.7]);
      break;
    case 'star': {
      const pts: number[] = [];
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const r = k % 2 ? 0.4 : 1;
        pts.push(w / 2 + (Math.cos(a) * r * w) / 2, h / 2 + (Math.sin(a) * r * h) / 2 + h * 0.05);
      }
      p = poly(pts);
      break;
    }
    default:
      p = { k: 'rect', x: i, y: i, w, h, ...st };
  }
  return { prims: [p], height: el.height, cells: [] };
}

function layoutBarcode(el: BarcodeElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  const value = !env.design && el.expression ? defaultToString(evalExpr(el.expression, env.ctx)) : el.text;
  const inner: Prim[] = [];
  const w = el.width;
  const h = el.height;
  const pad = st.padding;
  try {
    if (el.symbology === 'qr') {
      const m = encodeQr(value);
      const n = m.length;
      const size = Math.min(w, h) - 2 * pad;
      const cell = size / n;
      const ox = (w - size) / 2;
      const oy = (h - size) / 2;
      for (let r = 0; r < n; r++) {
        let c = 0;
        while (c < n) {
          if (!m[r][c]) {
            c++;
            continue;
          }
          let e = c;
          while (e < n && m[r][e]) e++;
          inner.push({ k: 'rect', x: ox + c * cell, y: oy + r * cell, w: (e - c) * cell + 0.15, h: cell + 0.15, fill: el.barColor });
          c = e;
        }
      }
    } else {
      const modules = el.symbology === 'code39' ? encodeCode39(value) : el.symbology === 'ean13' ? encodeEan13(value) : encodeCode128(value);
      const font = fontOf(st);
      const textH = el.showText ? lineHeight(font) : 0;
      const barH = Math.max(4, h - textH - 2 * pad);
      const mw = (w - 2 * pad) / modules.length;
      let c = 0;
      while (c < modules.length) {
        if (modules[c] !== '1') {
          c++;
          continue;
        }
        let e = c;
        while (e < modules.length && modules[e] === '1') e++;
        inner.push({ k: 'rect', x: pad + c * mw, y: pad, w: (e - c) * mw, h: barH, fill: el.barColor });
        c = e;
      }
      if (el.showText) {
        const label = el.symbology === 'ean13' ? ean13Digits(value) : value;
        const m = fontMetrics(font);
        const lh = lineHeight(font);
        inner.push({ k: 'text', x: pad, y: pad + barH, w: w - 2 * pad, h: lh, asc: (lh - m.asc - m.desc) / 2 + m.asc, text: label, font, color: st.color, align: 'center' });
      }
    }
  } catch (e) {
    const t = textBox('Barcode: ' + (e as Error).message, w, h, { ...st, color: '#dc2626', backColor: '', borders: '' }, { wordWrap: true, canGrow: false, canShrink: false });
    inner.push(...t.prims);
  }
  return { prims: boxDecor({ ...st }, w, h, inner), height: h, cells: [] };
}

function layoutChart(el: ChartElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  const rows = env.ctx.rows ?? [];
  const data = buildChartData(el, rows, env.ctx);
  const svg = chartSvg(el, data, el.width, el.height, fontOf(st), st.color, fmtOpts(env));
  const bg: Prim[] = st.backColor ? [] : [{ k: 'rect', x: 0, y: 0, w: el.width, h: el.height, fill: '#ffffff' }];
  return { prims: [...bg, ...boxDecor(st, el.width, el.height, [{ k: 'svg', x: 0, y: 0, w: el.width, h: el.height, svg }])], height: el.height, cells: [] };
}

function layoutCheckbox(el: CheckboxElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  const checked = !env.design && el.expression ? truthy(evalExpr(el.expression, env.ctx)) : el.checked;
  const font = fontOf(st);
  const s = Math.min(el.height - 2, Math.round(lineHeight(font)) - 2, 16);
  const by = (el.height - s) / 2;
  const inner: Prim[] = [{ k: 'rect', x: st.padding, y: by, w: s, h: s, fill: '#ffffff', stroke: st.color, sw: 1, ls: 'solid' }];
  if (checked) {
    const x = st.padding;
    inner.push({ k: 'poly', pts: [x + s * 0.2, by + s * 0.55, x + s * 0.42, by + s * 0.78, x + s * 0.82, by + s * 0.25], closed: false, stroke: st.color, sw: Math.max(1.4, s / 8), ls: 'solid' });
  }
  if (el.text) {
    const off = st.padding + s + 4;
    const t = textBox(el.text, el.width - off, el.height, { ...st, vAlign: 'middle', backColor: '', borders: '' }, { wordWrap: false, canGrow: false, canShrink: false });
    inner.push(...t.prims.map((p) => shiftPrim(p, off, 0)));
  }
  return {
    prims: boxDecor(st, el.width, el.height, inner),
    height: el.height,
    cells: env.design ? [] : [{ x: 0, y: 0, w: el.width, h: el.height, text: checked ? 'Yes' : 'No', value: checked, band: env.bandType }],
  };
}

export function pageInfoText(el: PageInfoElement, report: ReportDef, page: number, pageCount: number): string {
  const o = { locale: report.locale || 'en-US', currency: report.currency || 'USD' };
  const now = new Date();
  switch (el.info) {
    case 'pageNumber':
      return compositeFormat(el.format || '{0}', [page, pageCount], o);
    case 'pageNofM':
      return compositeFormat(el.format || 'Page {0} of {1}', [page, pageCount], o);
    case 'totalPages':
      return compositeFormat(el.format || '{0}', [pageCount], o);
    case 'date':
      return formatValue(now, el.format || 'd', o);
    case 'time':
      return formatValue(now, el.format || 't', o);
    case 'dateTime':
      return formatValue(now, el.format || 'g', o);
    case 'reportName':
      return el.format && el.format.includes('{0') ? compositeFormat(el.format, [report.name], o) : report.name;
  }
  return '';
}

function layoutPageInfo(el: PageInfoElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  const opts = { wordWrap: false, canGrow: false, canShrink: false };
  if (env.design) return { prims: textBox(pageInfoText(el, env.report, 1, 1), el.width, el.height, st, opts).prims, height: el.height, cells: [] };
  const pageDep = el.info === 'pageNumber' || el.info === 'pageNofM' || el.info === 'totalPages';
  if (pageDep && !env.pageScoped) {
    return {
      prims: [{ k: 'defer', x: 0, y: 0, w: el.width, h: el.height, render: (p, n) => textBox(pageInfoText(el, env.report, p, n), el.width, el.height, st, opts).prims }],
      height: el.height,
      cells: [],
    };
  }
  const text = pageInfoText(el, env.report, env.ctx.page ?? 1, env.ctx.pageCount ?? 1);
  return { prims: textBox(text, el.width, el.height, st, opts).prims, height: el.height, cells: [] };
}

function layoutTable(el: TableElement, env: LayoutEnv, st0: ResolvedStyle, ruleStyles: StyleProps[]): ElementLayout {
  void st0;
  const prims: Prim[] = [];
  const cells: CellInfo[] = [];
  const xs: number[] = [0];
  el.columns.forEach((w, i) => xs.push(xs[i] + w));
  const owners = cellOwners(el);
  const grow = !env.design && el.canGrow;
  // one entry per drawn cell (merged cells once, covered cells skipped)
  const items: { r: number; c: number; cs: number; rs: number; st: ResolvedStyle; v: { text: string; value: unknown }; w: number; need: number; wrap: boolean }[] = [];
  el.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (c >= el.columns.length) return;
      const o = owners[r][c];
      if (o.row !== r || o.col !== c) return;
      const { cs, rs } = effectiveSpan(el, r, c, owners);
      const st = resolveStyle(env.report, el.styleName, el.style, cell.style, ...ruleStyles);
      const v = env.design
        ? { text: designText(cell.text, cell.expression, cell.summaryFunc), value: null }
        : boundValue(env, cell.text, cell.expression, cell.format, cell.summaryFunc, 'none', '');
      const w = xs[c + cs] - xs[c];
      const wrap = !(env.design && cell.expression);
      const span0 = el.rows.slice(r, r + rs).reduce((a, x) => a + x.height, 0);
      const need = grow ? textBox(v.text, w, span0, st, { wordWrap: wrap, canGrow: true, canShrink: false }).height : span0;
      items.push({ r, c, cs, rs, st, v, w, need, wrap });
    });
  });
  // row heights: single-row cells first, then merged cells that need more room grow their last row
  const rh = el.rows.map((row) => row.height);
  for (const it of items) if (it.rs === 1) rh[it.r] = Math.max(rh[it.r], it.need);
  for (const it of items) {
    if (it.rs === 1) continue;
    const have = rh.slice(it.r, it.r + it.rs).reduce((a, b) => a + b, 0);
    if (it.need > have) rh[it.r + it.rs - 1] += it.need - have;
  }
  const ys: number[] = [0];
  rh.forEach((h, i) => ys.push(ys[i] + h));
  // backgrounds and text first, then every border line once on top (a neighbour's background must not cover
  // half of a shared line, and a shared line must not be drawn twice — that makes it look thicker)
  const borders: Prim[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const h = ys[it.r + it.rs] - ys[it.r];
    const box = textBox(it.v.text, it.w, h, it.st, { wordWrap: it.wrap, canGrow: false, canShrink: false, noBorders: true });
    prims.push(...box.prims.map((p) => shiftPrim(p, xs[it.c], ys[it.r])));
    for (const b of borderPrims(it.st, it.w, h)) {
      if (b.k !== 'line') continue;
      const s = shiftPrim(b, xs[it.c], ys[it.r]) as typeof b;
      const [ax, ay, bx, by] = s.x1 < s.x2 || (s.x1 === s.x2 && s.y1 <= s.y2) ? [s.x1, s.y1, s.x2, s.y2] : [s.x2, s.y2, s.x1, s.y1];
      const key = [ax, ay, bx, by].map((v) => Math.round(v * 10)).join(',') + '|' + s.color + '|' + s.width + '|' + (s.ls ?? '');
      if (seen.has(key)) continue;
      seen.add(key);
      borders.push(s);
    }
    if (!env.design)
      cells.push({
        x: xs[it.c],
        y: ys[it.r],
        w: it.w,
        h,
        text: it.v.text,
        value: el.rows[it.r].cells[it.c].expression ? it.v.value : it.v.text,
        bold: it.st.bold,
        align: it.st.textAlign,
        band: env.bandType,
        style: it.st,
        wrap: it.wrap,
      });
  }
  prims.push(...borders);
  return { prims, height: env.design ? el.height : ys[ys.length - 1], cells };
}

function layoutCrosstab(el: CrosstabElement, env: LayoutEnv, st: ResolvedStyle): ElementLayout {
  const o = fmtOpts(env);
  const opts = { wordWrap: false, canGrow: false, canShrink: false };
  const rh = el.rowHeight;
  const prims: Prim[] = [];
  const cells: CellInfo[] = [];
  const headerSt: ResolvedStyle = { ...st, bold: true, backColor: el.headerBackColor || st.backColor, textAlign: 'center', vAlign: 'middle' };
  const totalSt: ResolvedStyle = { ...st, bold: true, backColor: el.totalBackColor || st.backColor, textAlign: 'right', vAlign: 'middle' };
  const valSt: ResolvedStyle = { ...st, textAlign: 'right', vAlign: 'middle' };
  const rowHeadSt: ResolvedStyle = { ...st, bold: true, backColor: el.headerBackColor || st.backColor, vAlign: 'middle' };
  const put = (text: string, x: number, y: number, w: number, s: ResolvedStyle, value: unknown = text) => {
    prims.push(...textBox(text, w, rh, s, opts).prims.map((p) => shiftPrim(p, x, y)));
    if (!env.design) cells.push({ x, y, w, h: rh, text, value, bold: s.bold, align: s.textAlign, band: env.bandType, style: s });
  };
  if (env.design || !el.rowField || !el.columnField) {
    const cw = el.cellWidth;
    put(el.corner, 0, 0, el.rowHeaderWidth, headerSt);
    put(el.columnField ? designText('', el.columnField) : '[Columns]', el.rowHeaderWidth, 0, cw * 2, headerSt);
    if (el.showRowTotals) put('Total', el.rowHeaderWidth + cw * 2, 0, cw, headerSt);
    put(el.rowField ? designText('', el.rowField) : '[Rows]', 0, rh, el.rowHeaderWidth, rowHeadSt);
    put(el.valueField ? designText('', el.valueField, el.aggregate) : '[Data]', el.rowHeaderWidth, rh, cw * 2, valSt);
    if (el.showRowTotals) put('', el.rowHeaderWidth + cw * 2, rh, cw, totalSt);
    let h = rh * 2;
    if (el.showColumnTotals) {
      put('Grand Total', 0, h, el.rowHeaderWidth, { ...totalSt, textAlign: 'left' });
      put('', el.rowHeaderWidth, h, cw * 2, totalSt);
      if (el.showRowTotals) put('', el.rowHeaderWidth + cw * 2, h, cw, totalSt);
      h += rh;
    }
    return { prims, height: env.design ? el.height : h, cells };
  }
  const rows = env.ctx.rows ?? [];
  const rowRaw = new Map<string, unknown>();
  const colRaw = new Map<string, unknown>();
  const buckets = new Map<string, unknown[]>();
  const rowB = new Map<string, unknown[]>();
  const colB = new Map<string, unknown[]>();
  const all: unknown[] = [];
  for (const row of rows) {
    const c = { ...env.ctx, row };
    const rv = evalExpr(el.rowField, c);
    const cv = evalExpr(el.columnField, c);
    const rk = isDate(rv) ? formatValue(rv, 'd', o) : defaultToString(rv, o);
    const ck = isDate(cv) ? formatValue(cv, 'd', o) : defaultToString(cv, o);
    const v = el.valueField ? evalExpr(el.valueField, c) : 1;
    if (!rowRaw.has(rk)) rowRaw.set(rk, rv);
    if (!colRaw.has(ck)) colRaw.set(ck, cv);
    const key = rk + '\u0001' + ck;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(v);
    (rowB.get(rk) ?? rowB.set(rk, []).get(rk)!).push(v);
    (colB.get(ck) ?? colB.set(ck, []).get(ck)!).push(v);
    all.push(v);
  }
  const fn = (el.aggregate === 'none' ? 'sum' : el.aggregate).toLowerCase();
  const rks = [...rowRaw.keys()].sort((a, b) => compareValues(rowRaw.get(a), rowRaw.get(b)));
  const cks = [...colRaw.keys()].sort((a, b) => compareValues(colRaw.get(a), colRaw.get(b)));
  const fv = (vals?: unknown[]) => {
    if (!vals) return { t: '', v: null as unknown };
    const v = aggregateValues(fn, vals);
    return { t: formatValue(v, el.format, o), v };
  };
  const cw = el.cellWidth;
  const totalX = el.rowHeaderWidth + cks.length * cw;
  put(el.corner, 0, 0, el.rowHeaderWidth, headerSt);
  cks.forEach((ck, i) => put(ck, el.rowHeaderWidth + i * cw, 0, cw, headerSt));
  if (el.showRowTotals) put('Total', totalX, 0, cw, headerSt);
  let y = rh;
  for (const rk of rks) {
    put(rk, 0, y, el.rowHeaderWidth, rowHeadSt);
    cks.forEach((ck, i) => {
      const r = fv(buckets.get(rk + '\u0001' + ck));
      put(r.t, el.rowHeaderWidth + i * cw, y, cw, valSt, r.v);
    });
    if (el.showRowTotals) {
      const r = fv(rowB.get(rk));
      put(r.t, totalX, y, cw, totalSt, r.v);
    }
    y += rh;
  }
  if (el.showColumnTotals) {
    put('Grand Total', 0, y, el.rowHeaderWidth, { ...totalSt, textAlign: 'left' });
    cks.forEach((ck, i) => {
      const r = fv(colB.get(ck));
      put(r.t, el.rowHeaderWidth + i * cw, y, cw, totalSt, r.v);
    });
    if (el.showRowTotals) {
      const r = fv(all);
      put(r.t, totalX, y, cw, totalSt, r.v);
    }
    y += rh;
  }
  return { prims, height: y, cells };
}

export function layoutElement(el: ReportElement, env: LayoutEnv): ElementLayout {
  const rules = applyRules(el, env);
  if (rules.hidden) {
    const shrink = el.type === 'text' && el.canShrink;
    return { prims: [], height: shrink ? 0 : el.height, cells: [], hidden: true };
  }
  const st = el.type === 'table' ? resolveStyle(env.report, el.styleName, el.style) : resolveStyle(env.report, el.styleName, el.style, ...rules.styles);
  let res: ElementLayout;
  switch (el.type) {
    case 'text':
      res = layoutText(el, env, st);
      break;
    case 'image':
      res = layoutImage(el, env, st);
      break;
    case 'line':
      res = layoutLine(el);
      break;
    case 'shape':
      res = layoutShape(el);
      break;
    case 'barcode':
      res = layoutBarcode(el, env, st);
      break;
    case 'chart':
      res = layoutChart(el, env, st);
      break;
    case 'checkbox':
      res = layoutCheckbox(el, env, st);
      break;
    case 'pageInfo':
      res = layoutPageInfo(el, env, st);
      break;
    case 'table':
      res = layoutTable(el, env, st, rules.styles);
      break;
    case 'crosstab':
      res = layoutCrosstab(el, env, st);
      break;
    default:
      res = { prims: [], height: (el as ReportElement).height, cells: [] };
  }
  if (!env.design && el.bookmark && el.bookmark.trim()) {
    const b = evalExpr(el.bookmark, env.ctx);
    res.bookmark = defaultToString(b, fmtOpts(env));
  }
  return res;
}

// ------------------------------------------------------------------ bands
export interface BandLayout {
  height: number;
  prims: Prim[];
  cells: CellInfo[];
  bookmarks: { text: string; y: number }[];
}

export function bandVisible(band: Band, env: LayoutEnv): boolean {
  if (!band.visible) return false;
  if (!env.design && band.visibleExpr && band.visibleExpr.trim()) return truthy(evalExpr(band.visibleExpr, env.ctx));
  return true;
}

/**
 * Lay out all elements of a band. Elements that grow push down the elements below them.
 * Returned prims are relative to the band's top-left (content area origin).
 */
export function layoutBand(band: Band, elements: ReportElement[], env: LayoutEnv, width: number, backColor?: string): BandLayout {
  const els = elements.filter((e) => e.bandId === band.id).sort((a, b) => a.y - b.y || a.x - b.x);
  const results = els.map((el) => ({ el, r: layoutElement(el, env), off: 0 }));
  let designedBottom = 0;
  let newBottom = 0;
  let anyShrink = false;
  for (let i = 0; i < results.length; i++) {
    const cur = results[i];
    let off: number | null = null;
    for (let j = 0; j < i; j++) {
      const o = results[j];
      if (o.el.y + o.el.height <= cur.el.y + 0.5) {
        const d = o.off + (o.r.height - o.el.height);
        off = off === null ? d : Math.max(off, d);
      }
    }
    cur.off = off ?? 0;
    if (cur.r.height < cur.el.height) anyShrink = true;
    designedBottom = Math.max(designedBottom, cur.el.y + cur.el.height);
    newBottom = Math.max(newBottom, cur.el.y + cur.off + cur.r.height);
  }
  let height = band.height;
  if (results.length) {
    const diff = newBottom - designedBottom;
    if (diff > 0 || (diff < 0 && anyShrink)) height = Math.max(0, band.height + diff);
  }
  if (env.design) height = band.height;
  const prims: Prim[] = [];
  const bg = backColor || band.backColor;
  if (bg && height > 0) prims.push({ k: 'rect', x: 0, y: 0, w: width, h: height, fill: bg });
  const cells: CellInfo[] = [];
  const bookmarks: { text: string; y: number }[] = [];
  for (const { el, r, off } of results) {
    const dy = el.y + off;
    for (const p of r.prims) prims.push(shiftPrim(p, el.x, dy));
    for (const c of r.cells) cells.push(shiftCell(c, el.x, dy));
    if (r.bookmark) bookmarks.push({ text: r.bookmark, y: dy });
  }
  return { height, prims, cells, bookmarks };
}
