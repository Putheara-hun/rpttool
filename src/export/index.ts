// Export entry points: HTML, print, PNG (zip for multiple pages), download helper.
import { zipSync } from 'fflate';
import type { RenderedDoc, RenderedPage } from '../engine/doc';
import { escXml, pageToSvg } from './svg';
import { svgToCanvas, toDataUrl } from './raster';
import { embeddedFontCss, googleFontsLink } from '../engine/fonts';

export { exportPdf } from './pdf';
export { exportXlsx, exportCsv } from './xlsx';

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeFileName(s: string) {
  return (s || 'report').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'report';
}

export interface HtmlOptions {
  /** a bar with the title, page count and a Print button (hidden when printing) */
  toolbar?: boolean;
  /** the report design, stored in the page so ReportTool can open the HTML file again */
  definition?: unknown;
}
export const HTML_DEFINITION_ID = 'reporttool-definition';

/** Font families of the text in a rendered document. */
export function docFamilies(doc: RenderedDoc): Set<string> {
  const out = new Set<string>();
  for (const p of doc.pages) for (const q of p.prims) if (q.k === 'text') out.add(q.font.family);
  return out;
}

export function exportHtml(doc: RenderedDoc, title: string, opts: HtmlOptions = {}): string {
  const fontsLink = googleFontsLink(docFamilies(doc));
  const p0 = doc.pages[0];
  const wmm = p0 ? (p0.width * 25.4) / 96 : 210;
  const hmm = p0 ? (p0.height * 25.4) / 96 : 297;
  const pages = doc.pages.map((p) => `<div class="page">${pageToSvg(p)}</div>`).join('\n');
  const bar = opts.toolbar
    ? `<div class="rt-bar"><b>${escXml(title)}</b><span>${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'} · ${escXml(new Date().toLocaleString())}</span><button type="button" onclick="window.print()">Print</button></div>\n`
    : '';
  // JSON inside <script>: "<" escaped so the text can never close the script element
  const def = opts.definition !== undefined ? `\n<script type="application/json" id="${HTML_DEFINITION_ID}">${JSON.stringify(opts.definition).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="generator" content="ReportTool"><title>${escXml(title)}</title>${fontsLink}
<style>
@page { size: ${wmm.toFixed(1)}mm ${hmm.toFixed(1)}mm; margin: 0; }
html,body { margin:0; padding:0; background:#e5e7eb; }
.page { margin: 16px auto; width: max-content; max-width: calc(100% - 16px); box-shadow: 0 2px 10px rgba(0,0,0,.2); background:#fff; line-height:0; }
.page svg { display:block; max-width: 100%; height: auto; }
.rt-bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; align-items: center; padding: 8px 16px; background: #1e3a8a; color: #fff; font: 13px system-ui, sans-serif; }
.rt-bar span { opacity: .8; flex: 1; }
.rt-bar button { font: inherit; padding: 4px 14px; border: 0; border-radius: 4px; background: #fff; color: #1e3a8a; cursor: pointer; }
@media print {
  html,body { background:#fff; }
  .rt-bar { display: none; }
  .page { margin:0; max-width: none; box-shadow:none; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .page svg { width:${wmm.toFixed(1)}mm; height:${hmm.toFixed(1)}mm; max-width: none; }
}
</style></head><body>
${bar}${pages}${def}
</body></html>`;
}

/** A self-contained HTML file: report pages (images inlined), print bar and the embedded design. */
export async function exportHtmlFile(doc: RenderedDoc, title: string, definition?: unknown): Promise<string> {
  const pages = await Promise.all(doc.pages.map(inlinePage));
  return exportHtml({ ...doc, pages }, title, { toolbar: true, definition });
}

/** The report design stored in an HTML file saved by ReportTool (null when there is none). */
export function readHtmlDefinition(html: string): unknown | null {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const s = d.getElementById(HTML_DEFINITION_ID);
  if (!s?.textContent) return null;
  return JSON.parse(s.textContent);
}

export function printDoc(doc: RenderedDoc, title: string) {
  const html = exportHtml(doc, title);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const idoc = iframe.contentWindow!.document;
  idoc.open();
  idoc.write(html);
  idoc.close();
  const go = () => {
    iframe.contentWindow!.focus();
    iframe.contentWindow!.print();
    setTimeout(() => iframe.remove(), 60000);
  };
  // wait for Google fonts (if any) before printing
  const fontsReady = (idoc as Document).fonts?.ready ?? Promise.resolve();
  void Promise.race([fontsReady, new Promise((r) => setTimeout(r, 4000))]).then(() => setTimeout(go, 300));
}

async function inlinePage(p: RenderedPage): Promise<RenderedPage> {
  const prims = await Promise.all(
    p.prims.map(async (q) => {
      if (q.k === 'image' && !q.src.startsWith('data:')) {
        try {
          return { ...q, src: await toDataUrl(q.src) };
        } catch {
          return q;
        }
      }
      return q;
    }),
  );
  let watermark = p.watermark;
  if (watermark?.image && !watermark.image.startsWith('data:')) {
    try {
      watermark = { ...watermark, image: await toDataUrl(watermark.image) };
    } catch {
      /* ignore */
    }
  }
  return { ...p, prims, watermark };
}

export async function pageToPng(p: RenderedPage, scale = 2): Promise<Blob> {
  const ip = await inlinePage(p);
  // an SVG drawn as an image cannot load web fonts: embed the Google fonts it uses
  const fams = new Set<string>();
  for (const q of p.prims) if (q.k === 'text') fams.add(q.font.family);
  const fontCss = await embeddedFontCss(fams).catch(() => '');
  let svg = pageToSvg(ip);
  if (fontCss) svg = svg.replace(/^(<svg[^>]*>)/, `$1<defs><style>${fontCss.replace(/</g, '')}</style></defs>`);
  const c = await svgToCanvas(svg, p.width, p.height, scale);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

/** One page -> PNG blob; several pages -> ZIP of PNGs. */
export async function exportPng(doc: RenderedDoc, baseName: string, scale = 2): Promise<{ blob: Blob; name: string }> {
  if (doc.pages.length === 1) return { blob: await pageToPng(doc.pages[0], scale), name: baseName + '.png' };
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < doc.pages.length; i++) {
    const b = await pageToPng(doc.pages[i], scale);
    files[`${baseName}_page${String(i + 1).padStart(3, '0')}.png`] = new Uint8Array(await b.arrayBuffer());
  }
  return { blob: new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }), name: baseName + '_png.zip' };
}
