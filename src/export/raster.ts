// Browser rasterization helpers (images, SVG -> canvas, colors).

const imgCache = new Map<string, Promise<HTMLImageElement>>();
export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load: ' + src.slice(0, 80)));
      img.src = src;
    });
    imgCache.set(src, p);
    p.catch(() => imgCache.delete(src));
  }
  return p;
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
