// Rendered pages -> rows and columns (an Excel sheet, Word tables) that look like the preview:
//   - the font, colours and alignment of each text box come with the box (CellInfo.style);
//   - fills and border lines are taken from what is drawn on the page (cell borders, table lines, band colours …).
import type { CellInfo, PText, RenderedPage } from '../engine/doc';
import type { LineStyle, ResolvedStyle } from '../model/types';
import { normColor } from './raster';

export interface Edge {
  /** RRGGBB */
  color: string;
  /** px */
  width: number;
  ls: LineStyle;
}
export interface Deco {
  /** RRGGBB */
  fill?: string;
  t?: Edge;
  r?: Edge;
  b?: Edge;
  l?: Edge;
}

/** a solid colour as RRGGBB (semi-transparent colours mixed with white); null = none */
export function solidHex(c: string | undefined): string | null {
  const v = normColor(c);
  if (!v) return null;
  const hex = v.hex.slice(1);
  if (v.alpha >= 0.999) return hex.toUpperCase();
  const mix = (i: number) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * v.alpha + 255 * (1 - v.alpha))
      .toString(16)
      .padStart(2, '0');
  return (mix(0) + mix(2) + mix(4)).toUpperCase();
}

interface Seg {
  at: number;
  a: number;
  b: number;
  e: Edge;
}

/** the fill and the four border lines of each text box, as drawn on the page */
export function pageDecor(page: RenderedPage, cells: CellInfo[]): Map<CellInfo, Deco> {
  const fills: { x: number; y: number; w: number; h: number; hex: string }[] = [];
  const hs = new Map<number, Seg[]>();
  const vs = new Map<number, Seg[]>();
  const put = (m: Map<number, Seg[]>, s: Seg) => {
    const k = Math.round(s.at);
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    l.push(s);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number, ls: LineStyle | undefined) => {
    const hex = solidHex(color);
    if (!hex || !(width > 0)) return;
    const e: Edge = { color: hex, width, ls: ls ?? 'solid' };
    if (Math.abs(y1 - y2) < 0.5) put(hs, { at: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2), e });
    else if (Math.abs(x1 - x2) < 0.5) put(vs, { at: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2), e });
  };
  for (const p of page.prims) {
    if (p.k === 'rect') {
      if (p.fill && (p.opacity === undefined || p.opacity >= 1)) {
        const hex = solidHex(p.fill);
        if (hex) fills.push({ x: p.x, y: p.y, w: p.w, h: p.h, hex });
      }
      if (p.stroke) {
        const w = p.sw ?? 1;
        line(p.x, p.y, p.x + p.w, p.y, p.stroke, w, p.ls);
        line(p.x, p.y + p.h, p.x + p.w, p.y + p.h, p.stroke, w, p.ls);
        line(p.x, p.y, p.x, p.y + p.h, p.stroke, w, p.ls);
        line(p.x + p.w, p.y, p.x + p.w, p.y + p.h, p.stroke, w, p.ls);
      }
    } else if (p.k === 'line') line(p.x1, p.y1, p.x2, p.y2, p.color, p.width, p.ls);
  }
  /** the last line drawn along this side (within 1.5px) that covers most of it */
  const edge = (m: Map<number, Seg[]>, at: number, a: number, b: number): Edge | undefined => {
    let found: Edge | undefined;
    const need = Math.max(1, Math.min(b - a - 2, (b - a) * 0.6));
    for (let k = Math.round(at) - 2; k <= Math.round(at) + 2; k++)
      for (const s of m.get(k) ?? []) if (Math.abs(s.at - at) <= 1.5 && Math.min(b, s.b) - Math.max(a, s.a) >= need) found = s.e;
    return found;
  };
  const out = new Map<CellInfo, Deco>();
  for (const c of cells) {
    const d: Deco = {};
    for (let i = fills.length - 1; i >= 0; i--) {
      const f = fills[i];
      const ow = Math.min(c.x + c.w, f.x + f.w) - Math.max(c.x, f.x);
      const oh = Math.min(c.y + c.h, f.y + f.h) - Math.max(c.y, f.y);
      if (ow > 0 && oh > 0 && ow * oh >= 0.6 * c.w * c.h) {
        if (f.hex !== 'FFFFFF') d.fill = f.hex;
        break;
      }
    }
    d.t = edge(hs, c.y, c.x, c.x + c.w);
    d.b = edge(hs, c.y + c.h, c.x, c.x + c.w);
    d.l = edge(vs, c.x, c.y, c.y + c.h);
    d.r = edge(vs, c.x + c.w, c.y, c.y + c.h);
    out.set(c, d);
  }
  return out;
}

/** text drawn outside the text boxes (page numbers, dates of page info items …) as boxes of their own */
export function looseText(page: RenderedPage): CellInfo[] {
  const inBox = (p: PText) => {
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return page.cells.some((c) => cx >= c.x - 1 && cx <= c.x + c.w + 1 && cy >= c.y - 1 && cy <= c.y + c.h + 1);
  };
  const out: CellInfo[] = [];
  for (const p of page.prims) {
    if (p.k !== 'text' || !p.text.trim() || inBox(p)) continue;
    const style: ResolvedStyle = {
      fontFamily: p.font.family,
      fontSize: p.font.size,
      bold: p.font.bold,
      italic: p.font.italic,
      underline: !!p.underline,
      strike: !!p.strike,
      color: p.color,
      backColor: '',
      textAlign: p.align,
      vAlign: 'top',
      padding: 0,
      borders: '',
      borderWidth: 0,
      borderColor: '',
      borderStyle: 'solid',
    };
    out.push({ x: p.x, y: p.y, w: p.w, h: p.h, text: p.text, value: p.text, bold: p.font.bold, align: p.align, band: '', style, wrap: false });
  }
  return out;
}

/** a text box placed on the grid; `top` = its y in the whole grid (pages one after another for a sheet) */
export interface Placed {
  c: CellInfo;
  page: number;
  top: number;
  deco: Deco;
  /** only takes room (rows / columns) — a picture placed over the grid, not a cell */
  ghost?: boolean;
}
export interface GridCell extends Placed {
  row: number;
  col: number;
  /** last row / column it covers (merged cells) */
  endRow: number;
  endCol: number;
  text: string;
}
export interface GridRow {
  top: number;
  /** px */
  height: number;
  page: number;
  /** an empty gap of the page (keeps the spacing of the preview) */
  spacer?: boolean;
}
export interface Grid {
  /** left edge of each column (px) */
  xs: number[];
  colWidths: number[];
  rows: GridRow[];
  cells: GridCell[];
}

function cluster(values: number[], tol: number): number[] {
  const s = [...new Set(values.map((v) => Math.round(v * 10) / 10))].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}
/** the last anchor at or before v */
function anchorOf(anchors: number[], v: number): number {
  let lo = 0;
  let hi = anchors.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid] <= v + 0.5) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Rows and columns from the boxes' edges. A box wider / taller than one column / row covers the next ones (merged),
 * never over another box. An empty gap of `minGap` px or more between rows of a page becomes a row of its own.
 */
export function makeGrid(items: Placed[], minGap = 6): Grid {
  if (!items.length) return { xs: [], colWidths: [], rows: [], cells: [] };
  const xs = cluster(
    items.map((i) => i.c.x),
    3,
  );
  const tops = cluster(
    items.map((i) => i.top),
    2,
  );
  const byTop: Placed[][] = tops.map(() => []);
  for (const it of items) byTop[anchorOf(tops, it.top)].push(it);

  const rows: GridRow[] = [];
  const rowAt: number[] = [];
  const maxBottom = (l: Placed[]) => l.reduce((m, it) => Math.max(m, it.top + it.c.h), -Infinity);
  for (let t = 0; t < tops.length; t++) {
    // every anchor has its boxes (anchors are the boxes' own tops)
    const list = byTop[t];
    const page = list[0].page;
    const top = tops[t];
    const next = t + 1 < tops.length && byTop[t + 1][0].page === page ? tops[t + 1] : null;
    const fit = list.filter((it) => next === null || it.top + it.c.h <= next + 2);
    const bottom = fit.length ? maxBottom(fit) : (next ?? maxBottom(list));
    rowAt[t] = rows.length;
    if (next !== null && next - bottom >= minGap) {
      rows.push({ top, height: bottom - top, page });
      rows.push({ top: bottom, height: next - bottom, page, spacer: true });
    } else rows.push({ top, height: Math.max(1, (next ?? bottom) - top), page });
  }

  const anchors = new Map<string, GridCell>();
  const cells: GridCell[] = [];
  const sorted = [...items].sort((a, b) => a.top - b.top || a.c.x - b.c.x);
  for (const it of sorted) {
    if (it.ghost) continue;
    const row = rowAt[anchorOf(tops, it.top)];
    const col = anchorOf(xs, it.c.x);
    const key = row + ',' + col;
    const ex = anchors.get(key);
    if (ex) {
      // two boxes on the same spot: one cell with both texts
      if (it.c.text) ex.text = ex.text ? ex.text + ' ' + it.c.text : it.c.text;
      continue;
    }
    let endCol = col;
    while (endCol + 1 < xs.length && xs[endCol + 1] < it.c.x + it.c.w - 3) endCol++;
    let endRow = row;
    while (endRow + 1 < rows.length && rows[endRow + 1].page === rows[row].page && rows[endRow + 1].top < it.top + it.c.h - 2) endRow++;
    const g: GridCell = { ...it, row, col, endRow, endCol, text: it.c.text };
    anchors.set(key, g);
    cells.push(g);
  }
  // merged areas never cover another box (top-left boxes first)
  const taken = new Set<string>();
  const busy = (r: number, k: number, self: GridCell) => {
    const a = anchors.get(r + ',' + k);
    return (a && a !== self) || taken.has(r + ',' + k);
  };
  for (const g of cells) {
    for (let k = g.col + 1; k <= g.endCol; k++)
      if (busy(g.row, k, g)) {
        g.endCol = k - 1;
        break;
      }
    outer: for (let r = g.row + 1; r <= g.endRow; r++)
      for (let k = g.col; k <= g.endCol; k++)
        if (busy(r, k, g)) {
          g.endRow = r - 1;
          break outer;
        }
    for (let r = g.row; r <= g.endRow; r++) for (let k = g.col; k <= g.endCol; k++) taken.add(r + ',' + k);
  }

  const lastRight = cells.reduce((m, g) => (g.endCol === xs.length - 1 ? Math.max(m, g.c.x + g.c.w) : m), xs[xs.length - 1] + 20);
  const colWidths = xs.map((x, i) => (i + 1 < xs.length ? xs[i + 1] - x : lastRight - x));
  return { xs, colWidths, rows, cells };
}

/** font, colour and alignment of a box (its style; boxes without one: the first text drawn inside) */
export interface Look {
  family: string;
  /** pt */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** RRGGBB */
  color: string;
  align: 'left' | 'center' | 'right' | 'justify';
  vAlign: 'top' | 'middle' | 'bottom';
  /** px */
  padding: number;
  wrap: boolean;
}
export function lookOf(c: CellInfo, page?: RenderedPage): Look {
  const s = c.style;
  if (s)
    return {
      family: s.fontFamily || 'Arial',
      size: s.fontSize || 10,
      bold: !!s.bold,
      italic: !!s.italic,
      underline: !!s.underline,
      strike: !!s.strike,
      color: solidHex(s.color) ?? '000000',
      align: s.textAlign || 'left',
      vAlign: s.vAlign || 'top',
      padding: s.padding ?? 2,
      wrap: !!c.wrap || /\n/.test(c.text),
    };
  const t = page?.prims.find((p): p is PText => p.k === 'text' && p.x >= c.x - 1 && p.y >= c.y - 1 && p.x <= c.x + c.w && p.y <= c.y + c.h);
  return {
    family: t?.font.family || 'Arial',
    size: t?.font.size || 10,
    bold: t?.font.bold ?? !!c.bold,
    italic: !!t?.font.italic,
    underline: !!t?.underline,
    strike: !!t?.strike,
    color: solidHex(t?.color) ?? '000000',
    align: (c.align as Look['align']) || t?.align || 'left',
    vAlign: 'top',
    padding: 2,
    wrap: /\n/.test(c.text),
  };
}
