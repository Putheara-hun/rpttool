// Chart building (data aggregation) and SVG rendering.
import type { ChartElement, Row } from '../model/types';
import { PT } from '../model/defaults';
import { aggregateValues, compareValues, evalExpr, type EvalContext } from './expression';
import { defaultToString, formatValue, type FormatOptions } from './format';
import { textWidth, fitText, type FontSpec } from './measure';

export const DEFAULT_PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

export interface ChartData {
  categories: string[];
  series: { name: string; values: number[] }[];
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildChartData(el: ChartElement, rows: Row[], ctx: EvalContext): ChartData {
  if (!el.argument) {
    // placeholder data for an unbound chart
    return {
      categories: ['A', 'B', 'C', 'D', 'E'],
      series: el.series ? [{ name: 'Series 1', values: [4, 7, 5, 9, 6] }, { name: 'Series 2', values: [3, 5, 6, 4, 8] }] : [{ name: 'Value', values: [4, 7, 5, 9, 6] }],
    };
  }
  const catKeys: string[] = [];
  const catRaw = new Map<string, unknown>();
  const seriesKeys: string[] = [];
  const buckets = new Map<string, unknown[]>();
  for (const row of rows) {
    const c = { ...ctx, row };
    const a = evalExpr(el.argument, c);
    const ak = defaultToString(a, ctx.fmt);
    const sk = el.series ? defaultToString(evalExpr(el.series, c), ctx.fmt) : 'Value';
    const v = el.value ? evalExpr(el.value, c) : 1;
    if (!catRaw.has(ak)) {
      catRaw.set(ak, a);
      catKeys.push(ak);
    }
    if (!seriesKeys.includes(sk)) seriesKeys.push(sk);
    const key = sk + '\u0001' + ak;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(v);
  }
  const fnName = el.aggregate === 'none' ? 'sum' : el.aggregate.toLowerCase();
  let series = seriesKeys.map((s) => ({
    name: s,
    values: catKeys.map((c) => {
      const vals = buckets.get(s + '\u0001' + c);
      const r = vals ? aggregateValues(fnName, vals) : 0;
      return typeof r === 'number' ? r : Number(r) || 0;
    }),
  }));
  let order = catKeys.map((_, i) => i);
  const total = (i: number) => series.reduce((s, x) => s + x.values[i], 0);
  if (el.sortBy === 'argument') order.sort((i, j) => compareValues(catRaw.get(catKeys[i]), catRaw.get(catKeys[j])));
  else if (el.sortBy === 'valueAsc') order.sort((i, j) => total(i) - total(j));
  else if (el.sortBy === 'valueDesc') order.sort((i, j) => total(j) - total(i));
  if (el.topN > 0 && order.length > el.topN) {
    if (el.sortBy === 'none' || el.sortBy === 'argument') {
      const top = [...order].sort((i, j) => total(j) - total(i)).slice(0, el.topN);
      order = order.filter((i) => top.includes(i));
    } else order = order.slice(0, el.topN);
  }
  series = series.map((s) => ({ name: s.name, values: order.map((i) => s.values[i]) }));
  return { categories: order.map((i) => catKeys[i]), series };
}

function niceNum(range: number, round: boolean) {
  const exp = Math.floor(Math.log10(range || 1));
  const f = range / Math.pow(10, exp);
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}
function niceScale(min: number, max: number, ticks = 5) {
  if (min === max) {
    max = min + 1;
    if (min > 0) min = 0;
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / (ticks - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return { lo, hi, ticks: out };
}

function shortNum(v: number) {
  const a = Math.abs(v);
  if (a >= 1e9) return +(v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return +(v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return +(v / 1e3).toFixed(1) + 'K';
  return String(+v.toFixed(2));
}

export function chartSvg(el: ChartElement, data: ChartData, w: number, h: number, font: FontSpec, color: string, fmt: FormatOptions): string {
  const pal = el.palette ? el.palette.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_PALETTE;
  const colorAt = (i: number) => pal[i % pal.length];
  const px = font.size * PT;
  const fam = esc(font.family);
  const txt = (x: number, y: number, s: string, opts: { anchor?: string; size?: number; bold?: boolean; fill?: string; rotate?: number } = {}) =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${fam}, Arial, sans-serif" font-size="${(opts.size ?? px).toFixed(1)}"${opts.bold ? ' font-weight="bold"' : ''} fill="${opts.fill ?? color}" text-anchor="${opts.anchor ?? 'start'}"${
      opts.rotate ? ` transform="rotate(${opts.rotate} ${x.toFixed(1)} ${y.toFixed(1)})"` : ''
    }>${esc(s)}</text>`;
  const out: string[] = [];
  let top = 6;
  const pad = 6;
  if (el.title) {
    const ts = px * 1.25;
    out.push(txt(w / 2, top + ts, fitText(el.title, { ...font, size: font.size * 1.25, bold: true }, w - 8), { anchor: 'middle', size: ts, bold: true }));
    top += ts * 1.5;
  }
  const isPie = el.chartType === 'pie' || el.chartType === 'doughnut';
  const legendItems = isPie ? data.categories : data.series.length > 1 ? data.series.map((s) => s.name) : [];
  let right = w - pad;
  if (el.showLegend && legendItems.length) {
    const lw = Math.min(w * 0.35, Math.max(...legendItems.map((s) => textWidth(s, font))) + px + 14);
    const lx = w - pad - lw;
    const lh = px * 1.4;
    const startY = Math.max(top, (top + h) / 2 - (legendItems.length * lh) / 2);
    legendItems.forEach((name, i) => {
      const y = startY + i * lh;
      if (y + lh > h) return;
      out.push(`<rect x="${lx.toFixed(1)}" y="${(y + lh * 0.2).toFixed(1)}" width="${(px * 0.8).toFixed(1)}" height="${(px * 0.8).toFixed(1)}" fill="${colorAt(i)}"/>`);
      out.push(txt(lx + px + 4, y + lh * 0.2 + px * 0.75, fitText(name, font, lw - px - 6)));
    });
    right = lx - 8;
  }
  const bottom = h - pad;
  if (isPie) {
    const vals = data.series[0]?.values ?? [];
    const total = vals.reduce((s, v) => s + Math.max(0, v), 0) || 1;
    const cx = (pad + right) / 2;
    const cy = (top + bottom) / 2;
    const r = Math.max(4, Math.min(right - pad, bottom - top) / 2 - 2);
    const ir = el.chartType === 'doughnut' ? r * 0.55 : 0;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const frac = Math.max(0, v) / total;
      if (frac <= 0) return;
      const a1 = a0 + frac * Math.PI * 2;
      const c = colorAt(i);
      if (frac >= 0.9999) {
        out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`);
        if (ir) out.push(`<circle cx="${cx}" cy="${cy}" r="${ir}" fill="#fff"/>`);
      } else {
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (ang: number, rr: number) => `${(cx + rr * Math.cos(ang)).toFixed(2)} ${(cy + rr * Math.sin(ang)).toFixed(2)}`;
        const d = ir
          ? `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, ir)} A${ir} ${ir} 0 ${large} 0 ${p(a0, ir)} Z`
          : `M${cx} ${cy} L${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} Z`;
        out.push(`<path d="${d}" fill="${c}" stroke="#fff" stroke-width="1"/>`);
      }
      if (el.showLabels && frac > 0.03) {
        const mid = (a0 + a1) / 2;
        const lr = ir ? (r + ir) / 2 : r * 0.65;
        out.push(txt(cx + lr * Math.cos(mid), cy + lr * Math.sin(mid) + px * 0.35, (frac * 100).toFixed(frac < 0.1 ? 1 : 0) + '%', { anchor: 'middle', fill: '#fff', bold: true }));
      }
      a0 = a1;
    });
    return out.join('');
  }
  // ---------------------------------------------------------- axis charts
  const all = data.series.flatMap((s) => s.values);
  const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const fmtV = (v: number) => (el.valueFormat ? formatValue(v, el.valueFormat, fmt) : shortNum(v));
  const horizontal = el.chartType === 'bar';
  const valueLabelW = Math.max(...sc.ticks.map((t) => textWidth(fmtV(t), font))) + 6;
  const catLabelW = Math.min(w * 0.3, Math.max(0, ...data.categories.map((c) => textWidth(c, font))) + 6);
  const left = pad + (horizontal ? catLabelW : valueLabelW);
  const plotBottom = bottom - px * 1.5;
  const plotTop = top + (el.showLabels ? px : 2);
  const tailPad = horizontal ? textWidth(fmtV(sc.ticks[sc.ticks.length - 1]), font) / 2 + 2 : 0;
  const pw = Math.max(10, right - left - tailPad);
  const ph = Math.max(10, plotBottom - plotTop);
  const n = Math.max(1, data.categories.length);
  const vpos = (v: number) => ((v - sc.lo) / (sc.hi - sc.lo || 1)) * (horizontal ? pw : ph);
  // grid & value axis
  for (const t of sc.ticks) {
    if (horizontal) {
      const x = left + vpos(t);
      out.push(`<line x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="#e5e7eb" stroke-width="1"/>`);
      out.push(txt(x, plotBottom + px * 1.15, fmtV(t), { anchor: 'middle', fill: '#6b7280' }));
    } else {
      const y = plotBottom - vpos(t);
      out.push(`<line x1="${left}" y1="${y.toFixed(1)}" x2="${left + pw}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
      out.push(txt(left - 4, y + px * 0.35, fmtV(t), { anchor: 'end', fill: '#6b7280' }));
    }
  }
  const band = (horizontal ? ph : pw) / n;
  // category labels
  const step = Math.max(1, Math.ceil((horizontal ? px * 1.2 : 40) / band));
  data.categories.forEach((c, i) => {
    if (i % step) return;
    if (horizontal) out.push(txt(left - 4, plotTop + band * (i + 0.5) + px * 0.35, fitText(c, font, catLabelW - 6), { anchor: 'end' }));
    else out.push(txt(left + band * (i + 0.5), plotBottom + px * 1.15, fitText(c, font, band * step - 4), { anchor: 'middle' }));
  });
  const zero = vpos(Math.max(sc.lo, 0));
  const ns = data.series.length;
  if (el.chartType === 'column' || el.chartType === 'bar') {
    const bw = (band * 0.75) / ns;
    data.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const a = vpos(v);
        const from = Math.min(a, zero);
        const len = Math.abs(a - zero);
        const off = band * 0.125 + si * bw;
        if (horizontal) {
          const y = plotTop + band * i + off;
          out.push(`<rect x="${(left + from).toFixed(1)}" y="${y.toFixed(1)}" width="${len.toFixed(1)}" height="${Math.max(1, bw - 1).toFixed(1)}" fill="${colorAt(si)}"/>`);
          if (el.showLabels) out.push(txt(left + a + 3, y + bw / 2 + px * 0.35, fmtV(v), { size: px * 0.9 }));
        } else {
          const x = left + band * i + off;
          out.push(`<rect x="${x.toFixed(1)}" y="${(plotBottom - from - len).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${len.toFixed(1)}" fill="${colorAt(si)}"/>`);
          if (el.showLabels) out.push(txt(x + bw / 2, plotBottom - a - 3, fmtV(v), { anchor: 'middle', size: px * 0.9 }));
        }
      });
    });
  } else {
    data.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => [left + band * (i + 0.5), plotBottom - vpos(v)]);
      const c = colorAt(si);
      if (el.chartType === 'area' && pts.length) {
        const poly = [[pts[0][0], plotBottom - zero], ...pts, [pts[pts.length - 1][0], plotBottom - zero]];
        out.push(`<polygon points="${poly.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="${c}" fill-opacity="0.35"/>`);
      }
      out.push(`<polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${c}" stroke-width="2"/>`);
      pts.forEach((p, i) => {
        out.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${c}"/>`);
        if (el.showLabels) out.push(txt(p[0], p[1] - 5, fmtV(s.values[i]), { anchor: 'middle', size: px * 0.9 }));
      });
    });
  }
  // axes
  if (horizontal) out.push(`<line x1="${(left + zero).toFixed(1)}" y1="${plotTop}" x2="${(left + zero).toFixed(1)}" y2="${plotBottom}" stroke="#9ca3af"/>`);
  else out.push(`<line x1="${left}" y1="${(plotBottom - zero).toFixed(1)}" x2="${left + pw}" y2="${(plotBottom - zero).toFixed(1)}" stroke="#9ca3af"/>`);
  return out.join('');
}
