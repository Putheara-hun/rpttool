// Text measurement & line breaking (canvas based, cached).
import { PT } from '../model/defaults';
import { familyList } from './fontAliases';

export interface FontSpec {
  family: string;
  size: number; // pt
  bold: boolean;
  italic: boolean;
}

export const fontCss = (f: FontSpec) => `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${(f.size * PT).toFixed(2)}px ${familyList(f.family)}`;

let ctx2d: CanvasRenderingContext2D | null = null;
function getCtx(): CanvasRenderingContext2D | null {
  if (ctx2d) return ctx2d;
  if (typeof document === 'undefined') return null;
  ctx2d = document.createElement('canvas').getContext('2d');
  return ctx2d;
}

const widthCache = new Map<string, number>();
/** Forget measurements (a web font has finished loading: widths / metrics change). */
export function clearMeasureCache() {
  widthCache.clear();
  metricCache.clear();
  wrapCache.clear();
}
export function textWidth(text: string, font: FontSpec): number {
  const css = fontCss(font);
  const key = css + '\u0001' + text;
  let w = widthCache.get(key);
  if (w !== undefined) return w;
  const c = getCtx();
  if (c) {
    c.font = css;
    w = c.measureText(text).width;
  } else {
    w = text.length * font.size * PT * 0.55;
  }
  if (widthCache.size > 50000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

const metricCache = new Map<string, { asc: number; desc: number }>();
/** Font ascent/descent in px. */
export function fontMetrics(font: FontSpec): { asc: number; desc: number } {
  const css = fontCss(font);
  let m = metricCache.get(css);
  if (m) return m;
  const px = font.size * PT;
  const c = getCtx();
  if (c) {
    c.font = css;
    const tm = c.measureText('Hgjy');
    const asc = tm.fontBoundingBoxAscent ?? tm.actualBoundingBoxAscent ?? px * 0.8;
    const desc = tm.fontBoundingBoxDescent ?? tm.actualBoundingBoxDescent ?? px * 0.2;
    m = { asc: asc || px * 0.8, desc: desc || px * 0.2 };
  } else m = { asc: px * 0.8, desc: px * 0.2 };
  metricCache.set(css, m);
  return m;
}

export function lineHeight(font: FontSpec): number {
  const m = fontMetrics(font);
  return Math.max(m.asc + m.desc, font.size * PT * 1.15);
}

const segmenter: any =
  typeof Intl !== 'undefined' && (Intl as any).Segmenter ? new (Intl as any).Segmenter(undefined, { granularity: 'word' }) : null;
const graphemer: any =
  typeof Intl !== 'undefined' && (Intl as any).Segmenter ? new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' }) : null;

function words(p: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(p), (s: any) => s.segment as string);
  return p.split(/(\s+)/).filter((x) => x !== '');
}
function graphemes(s: string): string[] {
  if (graphemer) return Array.from(graphemer.segment(s), (x: any) => x.segment as string);
  return Array.from(s);
}

/** Truncate a string so it fits in maxWidth. */
export function fitText(s: string, font: FontSpec, maxWidth: number): string {
  if (textWidth(s, font) <= maxWidth) return s;
  const g = graphemes(s);
  let lo = 0;
  let hi = g.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(g.slice(0, mid).join(''), font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return g.slice(0, lo).join('');
}

const wrapCache = new Map<string, string[]>();
/** Break text into lines that fit maxWidth. */
export function wrapText(text: string, font: FontSpec, maxWidth: number, wordWrap: boolean): string[] {
  const key = fontCss(font) + '|' + maxWidth.toFixed(1) + '|' + (wordWrap ? 1 : 0) + '|' + text;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const out: string[] = [];
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (const p of paragraphs) {
    if (!wordWrap) {
      out.push(fitText(p, font, Math.max(1, maxWidth)));
      continue;
    }
    if (p === '' || textWidth(p, font) <= maxWidth) {
      out.push(p);
      continue;
    }
    let line = '';
    for (const w of words(p)) {
      const cand = line + w;
      if (textWidth(cand.trimEnd(), font) <= maxWidth) {
        line = cand;
        continue;
      }
      if (line.trim() !== '') {
        out.push(line.trimEnd());
        line = '';
      }
      const ws = w.trimStart();
      if (textWidth(ws, font) <= maxWidth) {
        line = ws;
        continue;
      }
      // word longer than the line: break by grapheme
      let chunk = '';
      for (const g of graphemes(ws)) {
        if (chunk && textWidth(chunk + g, font) > maxWidth) {
          out.push(chunk);
          chunk = g;
        } else chunk += g;
      }
      line = chunk;
    }
    out.push(line.trimEnd());
  }
  if (wrapCache.size > 20000) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}
