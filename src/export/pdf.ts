// PDF export (vector text/graphics via jsPDF; charts and non-Latin text are rasterized).
import type { jsPDF as JsPDF } from 'jspdf';
import type { Prim, RenderedDoc } from '../engine/doc';
import { fontCss, textWidth, type FontSpec } from '../engine/measure';
import { isGoogleFont } from '../engine/fonts';
import type { LineStyle, Watermark } from '../model/types';
import { PT } from '../model/defaults';
import { loadImage, normColor, svgToCanvas } from './raster';
import { watermarkSvg } from './svg';

const K = 0.75; // px -> pt

function pdfFont(f: FontSpec): [string, string] {
  const fam = f.family.toLowerCase();
  let name = 'helvetica';
  if (/times|georgia|garamond|serif|cambria|book/.test(fam) && !/sans/.test(fam)) name = 'times';
  if (/courier|consolas|mono|lucida console/.test(fam)) name = 'courier';
  const style = f.bold && f.italic ? 'bolditalic' : f.bold ? 'bold' : f.italic ? 'italic' : 'normal';
  return [name, style];
}

const latin1 = (s: string) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
};

function setDash(pdf: JsPDF, ls: LineStyle | undefined, w: number) {
  if (ls === 'dashed') pdf.setLineDashPattern([Math.max(3, w * 4) * K, Math.max(2, w * 2) * K], 0);
  else if (ls === 'dotted') pdf.setLineDashPattern([Math.max(1, w) * K, Math.max(2, w * 2) * K], 0);
  else pdf.setLineDashPattern([], 0);
}

function fillStroke(pdf: JsPDF, fill?: string, stroke?: string, sw?: number, ls?: LineStyle): string | null {
  const f = normColor(fill);
  const s = stroke && (sw ?? 1) > 0 ? normColor(stroke) : null;
  if (f) pdf.setFillColor(f.hex);
  if (s) {
    pdf.setDrawColor(s.hex);
    pdf.setLineWidth((sw ?? 1) * K);
    setDash(pdf, ls, sw ?? 1);
  }
  if (f && s) return 'FD';
  if (f) return 'F';
  if (s) return 'S';
  return null;
}

async function rasterText(pdf: JsPDF, p: Extract<Prim, { k: 'text' }>) {
  const S = 3;
  const tw = textWidth(p.text, p.font);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil((tw + 4) * S));
  c.height = Math.max(1, Math.ceil(p.h * S));
  const ctx = c.getContext('2d')!;
  ctx.scale(S, S);
  ctx.font = fontCss(p.font);
  ctx.fillStyle = p.color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(p.text, 2, p.asc);
  let x = p.x;
  if (p.align === 'center') x = p.x + (p.w - tw) / 2;
  else if (p.align === 'right') x = p.x + p.w - tw;
  pdf.addImage(c, 'PNG', (x - 2) * K, p.y * K, (tw + 4) * K, p.h * K, undefined, 'FAST');
}

async function drawPrim(pdf: JsPDF, p: Prim) {
  switch (p.k) {
    case 'rect': {
      const style = fillStroke(pdf, p.fill, p.stroke, p.sw, p.ls);
      if (!style || p.w <= 0 || p.h <= 0) return;
      if (p.opacity !== undefined) return; // highlight overlays are not exported
      if (p.r) pdf.roundedRect(p.x * K, p.y * K, p.w * K, p.h * K, p.r * K, p.r * K, style);
      else pdf.rect(p.x * K, p.y * K, p.w * K, p.h * K, style);
      return;
    }
    case 'line': {
      const c = normColor(p.color);
      if (!c || p.width <= 0) return;
      pdf.setDrawColor(c.hex);
      pdf.setLineWidth(p.width * K);
      setDash(pdf, p.ls, p.width);
      pdf.line(p.x1 * K, p.y1 * K, p.x2 * K, p.y2 * K);
      return;
    }
    case 'ellipse': {
      const style = fillStroke(pdf, p.fill, p.stroke, p.sw, p.ls);
      if (style) pdf.ellipse((p.x + p.w / 2) * K, (p.y + p.h / 2) * K, (p.w / 2) * K, (p.h / 2) * K, style);
      return;
    }
    case 'poly': {
      const style = fillStroke(pdf, p.closed ? p.fill : undefined, p.stroke, p.sw, p.ls);
      if (!style || p.pts.length < 4) return;
      const segs: number[][] = [];
      for (let i = 2; i < p.pts.length; i += 2) segs.push([(p.pts[i] - p.pts[i - 2]) * K, (p.pts[i + 1] - p.pts[i - 1]) * K]);
      pdf.lines(segs, p.pts[0] * K, p.pts[1] * K, [1, 1], style, p.closed);
      return;
    }
    case 'text': {
      if (!p.text) return;
      // PDF standard fonts cover Latin text in system fonts; other scripts and Google fonts are drawn as images
      if (!latin1(p.text) || isGoogleFont(p.font.family)) return rasterText(pdf, p);
      const [name, style] = pdfFont(p.font);
      pdf.setFont(name, style);
      pdf.setFontSize(p.font.size);
      const c = normColor(p.color) ?? { hex: '#000000', alpha: 1 };
      pdf.setTextColor(c.hex);
      const by = (p.y + p.asc) * K;
      let x = p.x * K;
      if (p.align === 'center') x = (p.x + p.w / 2) * K;
      else if (p.align === 'right') x = (p.x + p.w) * K;
      pdf.text(p.text, x, by, { align: p.align, baseline: 'alphabetic' });
      if (p.underline || p.strike) {
        const tw = pdf.getTextWidth(p.text);
        const x0 = p.align === 'center' ? x - tw / 2 : p.align === 'right' ? x - tw : x;
        pdf.setDrawColor(c.hex);
        pdf.setLineWidth(Math.max(0.5, p.font.size / 16));
        pdf.setLineDashPattern([], 0);
        if (p.underline) pdf.line(x0, by + p.font.size * 0.12, x0 + tw, by + p.font.size * 0.12);
        if (p.strike) pdf.line(x0, by - p.font.size * 0.3, x0 + tw, by - p.font.size * 0.3);
      }
      return;
    }
    case 'image': {
      try {
        const img = await loadImage(p.src);
        const S = 2;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.min(3000, Math.round(p.w * S)));
        c.height = Math.max(1, Math.min(3000, Math.round(p.h * S)));
        const ctx = c.getContext('2d')!;
        const iw = img.naturalWidth || 1;
        const ih = img.naturalHeight || 1;
        if (p.sizing === 'stretch') ctx.drawImage(img, 0, 0, c.width, c.height);
        else {
          const sc = p.sizing === 'cover' ? Math.max(c.width / iw, c.height / ih) : Math.min(c.width / iw, c.height / ih);
          const dw = iw * sc;
          const dh = ih * sc;
          ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
        }
        pdf.addImage(c, 'PNG', p.x * K, p.y * K, p.w * K, p.h * K, undefined, 'FAST');
      } catch {
        /* unreachable image: skipped */
      }
      return;
    }
    case 'svg': {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}">${p.svg}</svg>`;
      try {
        const c = await svgToCanvas(svg, p.w, p.h, 3);
        pdf.addImage(c, 'PNG', p.x * K, p.y * K, p.w * K, p.h * K, undefined, 'FAST');
      } catch {
        /* ignore */
      }
      return;
    }
  }
}

async function drawWatermark(pdf: JsPDF, wm: Watermark, w: number, h: number) {
  if (wm.image || !latin1(wm.text)) {
    // rasterize the whole watermark layer
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${watermarkSvg(wm, w, h)}</svg>`;
    try {
      const c = await svgToCanvas(svg, w, h, 1.5);
      pdf.addImage(c, 'PNG', 0, 0, w * K, h * K, undefined, 'FAST');
    } catch {
      /* ignore */
    }
    return;
  }
  if (!wm.text) return;
  const anyPdf = pdf as any;
  pdf.saveGraphicsState();
  try {
    anyPdf.setGState(new anyPdf.GState({ opacity: wm.opacity }));
  } catch {
    /* ignore */
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(wm.fontSize);
  pdf.setTextColor(normColor(wm.color)?.hex ?? '#c0c0c0');
  const tw = pdf.getTextWidth(wm.text);
  const a = (-wm.angle * Math.PI) / 180;
  const cx = (w / 2) * K;
  const cy = (h / 2) * K;
  const fs = wm.fontSize * (PT * K);
  const sx = cx - (tw / 2) * Math.cos(a) + 0.35 * fs * Math.sin(a);
  const sy = cy + (tw / 2) * Math.sin(a) + 0.35 * fs * Math.cos(a);
  pdf.text(wm.text, sx, sy, { angle: -wm.angle });
  pdf.restoreGraphicsState();
}

export async function exportPdf(doc: RenderedDoc, title: string, onProgress?: (page: number) => void): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  let pdf: JsPDF | null = null;
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const w = page.width * K;
    const h = page.height * K;
    const orientation = w > h ? 'landscape' : 'portrait';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
    else pdf.addPage([w, h], orientation);
    if (page.watermark?.behind) await drawWatermark(pdf, page.watermark, page.width, page.height);
    for (const p of page.prims) await drawPrim(pdf, p);
    if (page.watermark && !page.watermark.behind) await drawWatermark(pdf, page.watermark, page.width, page.height);
    onProgress?.(i + 1);
  }
  if (!pdf) pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  pdf.setProperties({ title, creator: 'ReportTool' });
  return pdf.output('blob');
}
