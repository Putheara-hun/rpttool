// Rendered document model: device independent drawing primitives in px (96 DPI).
import type { HAlign, ImageSizing, LineStyle, Watermark } from '../model/types';
import type { FontSpec } from './measure';

export interface PRect {
  k: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  ls?: LineStyle;
  r?: number;
  /** search highlight etc. */
  opacity?: number;
}
export interface PLine {
  k: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  ls: LineStyle;
}
export interface PText {
  k: 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  /** baseline offset from y */
  asc: number;
  text: string;
  font: FontSpec;
  color: string;
  align: Exclude<HAlign, 'justify'>;
  underline?: boolean;
  strike?: boolean;
}
export interface PEllipse {
  k: 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  ls?: LineStyle;
}
export interface PPoly {
  k: 'poly';
  pts: number[];
  closed: boolean;
  fill?: string;
  stroke?: string;
  sw?: number;
  ls?: LineStyle;
}
export interface PImage {
  k: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  sizing: ImageSizing;
}
/** Embedded SVG markup (charts). `svg` is inner markup in a 0..w x 0..h coordinate space. */
export interface PSvg {
  k: 'svg';
  x: number;
  y: number;
  w: number;
  h: number;
  svg: string;
}
/** Content that can only be produced when page numbers are known. */
export interface PDefer {
  k: 'defer';
  x: number;
  y: number;
  w: number;
  h: number;
  render: (page: number, pageCount: number) => Prim[];
}

export type Prim = PRect | PLine | PText | PEllipse | PPoly | PImage | PSvg | PDefer;

/** Text box information used for data-oriented exports (Excel/CSV) and search. */
export interface CellInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  value: unknown;
  bold?: boolean;
  align?: string;
  band: string;
}

export interface Bookmark {
  text: string;
  page: number;
  y: number;
  level: number;
}

export interface RenderedPage {
  width: number;
  height: number;
  prims: Prim[];
  cells: CellInfo[];
  watermark?: Watermark;
  background?: string;
}

export interface RenderedDoc {
  pages: RenderedPage[];
  bookmarks: Bookmark[];
  warnings: string[];
  timeMs: number;
}

export function primBounds(p: Prim): { x: number; y: number; w: number; h: number } {
  switch (p.k) {
    case 'line':
      return { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) };
    case 'poly': {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i < p.pts.length; i += 2) {
        x0 = Math.min(x0, p.pts[i]);
        x1 = Math.max(x1, p.pts[i]);
        y0 = Math.min(y0, p.pts[i + 1]);
        y1 = Math.max(y1, p.pts[i + 1]);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    default:
      return { x: p.x, y: p.y, w: p.w, h: p.h };
  }
}

export function shiftPrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.k) {
    case 'line':
      return { ...p, x1: p.x1 + dx, x2: p.x2 + dx, y1: p.y1 + dy, y2: p.y2 + dy };
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => (i % 2 ? v + dy : v + dx)) };
    default:
      return { ...p, x: p.x + dx, y: p.y + dy } as Prim;
  }
}

export function shiftCell(c: CellInfo, dx: number, dy: number): CellInfo {
  return { ...c, x: c.x + dx, y: c.y + dy };
}
