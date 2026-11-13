// Pictures of a rendered page for the file exports: linked images inlined (data: URLs), single pictures as PNG.
import { shiftPrim, type PImage, type PSvg, type RenderedPage } from '../engine/doc';
import { primToSvg } from './svg';
import { svgToCanvas, toDataUrl } from './raster';

/** the page with every linked image turned into a data: URL (an SVG drawn as an image cannot load links) */
export async function inlinePage(p: RenderedPage): Promise<RenderedPage> {
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

/** a picture or chart of the page as PNG bytes (drawn exactly as on the page: fit / fill / stretch kept) */
export async function picturePng(p: PImage | PSvg, scale = 2): Promise<Uint8Array | null> {
  if (p.w < 1 || p.h < 1) return null;
  let q: PImage | PSvg = shiftPrim(p, -p.x, -p.y) as PImage | PSvg;
  if (q.k === 'image') {
    if (!q.src) return null;
    if (!q.src.startsWith('data:')) {
      try {
        q = { ...q, src: await toDataUrl(q.src) };
      } catch {
        return null; // not readable (another site without CORS): left out
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${p.w}" height="${p.h}" viewBox="0 0 ${p.w} ${p.h}">${primToSvg(q)}</svg>`;
  try {
    const c = await svgToCanvas(svg, p.w, p.h, scale);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
