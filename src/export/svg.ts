// Primitives -> SVG markup (used by the designer, preview, print, HTML & PNG export).
import type { Prim, RenderedPage } from '../engine/doc';
import type { LineStyle, Watermark } from '../model/types';
import { PT } from '../model/defaults';

export const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 100) / 100).toString();
const n4 = (v: number) => (Math.round(v * 10000) / 10000).toString();

export function dash(ls: LineStyle | undefined, w: number): string {
  if (ls === 'dashed') return ` stroke-dasharray="${n(Math.max(3, w * 4))} ${n(Math.max(2, w * 2))}"`;
  if (ls === 'dotted') return ` stroke-dasharray="${n(Math.max(1, w))} ${n(Math.max(2, w * 2))}"`;
  return '';
}

const CRISP = ' shape-rendering="crispEdges"';

export const familyAttr = (f: string) => `'${f.replace(/'/g, '')}', Arial, sans-serif`;

/**
 * On screen: device pixels per page unit. Line widths are then rounded to whole device pixels so equal lines look
 * equal at any zoom (a 1px line at 141% would otherwise come out 1 or 2 pixels depending on its position).
 * Not used for print / PDF / exported files, which keep exact widths.
 */
let pixelScale = 0;
const sw = (w: number) => (pixelScale > 0 ? Math.max(1, Math.round(w * pixelScale)) / pixelScale : w);

export function primToSvg(p: Prim): string {
  switch (p.k) {
    case 'rect': {
      const fill = p.fill ? escXml(p.fill) : 'none';
      const crisp = p.stroke && !p.r ? CRISP : '';
      // outlined rectangles: snap the outline to whole pixels (sharp, even lines at any zoom)
      const w = crisp ? sw(p.sw ?? 1) : (p.sw ?? 1);
      const stroke = p.stroke ? ` stroke="${escXml(p.stroke)}" stroke-width="${n4(w)}"${dash(p.ls, p.sw ?? 1)}` : '';
      const r = p.r ? ` rx="${n(p.r)}" ry="${n(p.r)}"` : '';
      const op = p.opacity !== undefined ? ` fill-opacity="${p.opacity}"` : '';
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(Math.max(0, p.w))}" height="${n(Math.max(0, p.h))}" fill="${fill}"${op}${stroke}${r}${crisp}/>`;
    }
    case 'line': {
      // horizontal / vertical lines (table and cell borders, rules): one sharp pixel instead of two blurred ones
      const crisp = p.x1 === p.x2 || p.y1 === p.y2 ? CRISP : '';
      const w = crisp ? sw(p.width) : p.width;
      return `<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" stroke="${escXml(p.color)}" stroke-width="${n4(w)}"${dash(p.ls, p.width)}${crisp}/>`;
    }
    case 'text': {
      let x = p.x;
      let anchor = 'start';
      if (p.align === 'center') {
        x = p.x + p.w / 2;
        anchor = 'middle';
      } else if (p.align === 'right') {
        x = p.x + p.w;
        anchor = 'end';
      }
      const deco = [p.underline ? 'underline' : '', p.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      return `<text x="${n(x)}" y="${n(p.y + p.asc)}" font-family="${escXml(familyAttr(p.font.family))}" font-size="${n(p.font.size * PT)}"${p.font.bold ? ' font-weight="bold"' : ''}${
        p.font.italic ? ' font-style="italic"' : ''
      } fill="${escXml(p.color)}" text-anchor="${anchor}"${deco ? ` text-decoration="${deco}"` : ''} xml:space="preserve">${escXml(p.text)}</text>`;
    }
    case 'ellipse': {
      const fill = p.fill ? escXml(p.fill) : 'none';
      const stroke = p.stroke ? ` stroke="${escXml(p.stroke)}" stroke-width="${n(p.sw ?? 1)}"${dash(p.ls, p.sw ?? 1)}` : '';
      return `<ellipse cx="${n(p.x + p.w / 2)}" cy="${n(p.y + p.h / 2)}" rx="${n(Math.max(0, p.w / 2))}" ry="${n(Math.max(0, p.h / 2))}" fill="${fill}"${stroke}/>`;
    }
    case 'poly': {
      const pts: string[] = [];
      for (let i = 0; i < p.pts.length; i += 2) pts.push(n(p.pts[i]) + ',' + n(p.pts[i + 1]));
      const fill = p.fill && p.closed ? escXml(p.fill) : 'none';
      const stroke = p.stroke ? ` stroke="${escXml(p.stroke)}" stroke-width="${n(p.sw ?? 1)}" stroke-linejoin="round" stroke-linecap="round"${dash(p.ls, p.sw ?? 1)}` : '';
      return `<${p.closed ? 'polygon' : 'polyline'} points="${pts.join(' ')}" fill="${fill}"${stroke}/>`;
    }
    case 'image': {
      const par = p.sizing === 'stretch' ? 'none' : p.sizing === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
      return `<svg x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" viewBox="0 0 ${n(p.w)} ${n(p.h)}" overflow="hidden"><image href="${escXml(p.src)}" x="0" y="0" width="${n(
        p.w,
      )}" height="${n(p.h)}" preserveAspectRatio="${par}"/></svg>`;
    }
    case 'svg':
      return `<svg x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}" viewBox="0 0 ${n(p.w)} ${n(p.h)}" overflow="hidden">${p.svg}</svg>`;
    case 'defer':
      return '';
  }
}

export function primsToSvg(prims: Prim[]): string {
  let s = '';
  for (const p of prims) s += primToSvg(p);
  return s;
}

export function watermarkSvg(wm: Watermark, w: number, h: number): string {
  let s = '';
  if (wm.image) {
    const iw = w * 0.7;
    const ih = h * 0.7;
    s += `<image href="${escXml(wm.image)}" x="${n((w - iw) / 2)}" y="${n((h - ih) / 2)}" width="${n(iw)}" height="${n(ih)}" opacity="${wm.imageOpacity}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  if (wm.text) {
    const cx = w / 2;
    const cy = h / 2;
    s += `<text x="${n(cx)}" y="${n(cy)}" font-family="Arial, sans-serif" font-weight="bold" font-size="${n(wm.fontSize * PT)}" fill="${escXml(wm.color)}" fill-opacity="${
      wm.opacity
    }" text-anchor="middle" dominant-baseline="central" transform="rotate(${wm.angle} ${n(cx)} ${n(cy)})">${escXml(wm.text)}</text>`;
  }
  return s;
}

export interface PageSvgOptions {
  highlights?: { x: number; y: number; w: number; h: number; active?: boolean }[];
  /** emit width/height attributes in px (default) or scale factor */
  scale?: number;
  /** on-screen display: device pixels per page unit (zoom × devicePixelRatio) — lines get whole-pixel widths */
  pixelScale?: number;
}

export function pageToSvg(page: RenderedPage, opts: PageSvgOptions = {}): string {
  const sc = opts.scale ?? 1;
  const w = page.width;
  const h = page.height;
  let body = `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${page.background ?? '#ffffff'}"/>`;
  if (page.watermark && page.watermark.behind) body += watermarkSvg(page.watermark, w, h);
  pixelScale = opts.pixelScale ?? 0;
  try {
    body += primsToSvg(page.prims);
  } finally {
    pixelScale = 0;
  }
  if (page.watermark && !page.watermark.behind) body += watermarkSvg(page.watermark, w, h);
  for (const hl of opts.highlights ?? []) body += `<rect x="${n(hl.x)}" y="${n(hl.y)}" width="${n(hl.w)}" height="${n(hl.h)}" fill="${hl.active ? '#f97316' : '#facc15'}" fill-opacity="0.45"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(w * sc)}" height="${n(h * sc)}" viewBox="0 0 ${n(w)} ${n(h)}">${body}</svg>`;
}
