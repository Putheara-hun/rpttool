// Browser rasterization helpers (images, SVG -> canvas, colors).

const imgCache = new Map<string, Promise<HTMLImageElement>>();
function loadDirect(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load: ' + src.slice(0, 80)));
    img.src = src;
  });
}
/**
 * A picture that can be drawn into a canvas (PDF, PNG, Excel, Word …). A picture from a website that does not allow
 * that (no CORS — e.g. Google's picture servers) is fetched by the ReportTool server instead.
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src);
  if (!p) {
    const web = /^https?:/i.test(src);
    p = loadDirect(src, web).catch(async (e) => {
      const blob = web ? await imageViaServer(src) : null;
      if (!blob) throw e;
      return loadDirect(URL.createObjectURL(blob), false);
    });
    imgCache.set(src, p);
    p.catch(() => imgCache.delete(src));
  }
  return p;
}

/** a picture of another website, fetched by the ReportTool server (null where there is no such server) */
export async function imageViaServer(url: string): Promise<Blob | null> {
  try {
    const r = await fetch('./api/image?url=' + encodeURIComponent(url), { headers: { 'x-reporttool': '1' } });
    if (!r.ok) return null;
    const b = await r.blob();
    return b.type.startsWith('image/') ? b : null;
  } catch {
    return null;
  }
}

/**
 * A picture from a web address as a data: URL, to keep inside the report (then it prints and exports everywhere,
 * also when the website changes or is offline). Very large pictures are reduced to `maxSide` pixels.
 * null when the picture cannot be read at all.
 */
export async function webImageToDataUrl(url: string, maxSide = 1600): Promise<string | null> {
  let blob: Blob | null = null;
  try {
    const r = await fetch(url, { mode: 'cors' });
    if (r.ok) {
      const b = await r.blob();
      if (b.type.startsWith('image/')) blob = b;
    }
  } catch {
    /* the website does not allow it: ask the server */
  }
  blob ??= await imageViaServer(url);
  if (!blob) return null;
  const asDataUrl = (b: Blob) =>
    new Promise<string>((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = () => reject(rd.error);
      rd.readAsDataURL(b);
    });
  if (blob.type === 'image/svg+xml') return asDataUrl(blob); // drawings stay sharp
  try {
    const bmp = await createImageBitmap(blob);
    const big = Math.max(bmp.width, bmp.height);
    if (big <= maxSide && blob.size <= 1.5 * 1024 * 1024) {
      bmp.close();
      return asDataUrl(blob);
    }
    const k = Math.min(1, maxSide / big);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return blob.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png');
  } catch {
    return asDataUrl(blob);
  }
}

export async function svgToCanvas(svg: string, w: number, h: number, scale: number): Promise<HTMLCanvasElement> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('SVG rasterization failed'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fetch an image and convert it into a data: URL (needed for SVG -> PNG). */
export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  const img = await loadImage(src);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || 1;
  c.height = img.naturalHeight || 1;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

let colorCtx: CanvasRenderingContext2D | null = null;
const colorCache = new Map<string, { hex: string; alpha: number } | null>();
/** Normalize any CSS color to #rrggbb + alpha. Returns null for transparent / invalid. */
export function normColor(c: string | undefined): { hex: string; alpha: number } | null {
  if (!c) return null;
  if (colorCache.has(c)) return colorCache.get(c)!;
  colorCtx ??= document.createElement('canvas').getContext('2d');
  let res: { hex: string; alpha: number } | null = null;
  if (colorCtx) {
    colorCtx.fillStyle = '#010203';
    colorCtx.fillStyle = c;
    const v = String(colorCtx.fillStyle);
    if (v.startsWith('#')) res = v === '#010203' && c.toLowerCase() !== '#010203' ? null : { hex: v, alpha: 1 };
    else {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v);
      if (m) {
        const hex = '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
        const alpha = m[4] === undefined ? 1 : Number(m[4]);
        res = alpha <= 0 ? null : { hex, alpha };
      }
    }
  }
  colorCache.set(c, res);
  return res;
}
