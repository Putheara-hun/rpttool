// Colour helpers for the colour picker (palette generation, conversions, recent colours).
import { ref } from 'vue';

export const THEME_BASE = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
export const STANDARD = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase();

function mix(hex: string, target: number, f: number) {
  const c = hexToRgb(hex)!;
  return rgbToHex(...(c.map((v) => v + (target - v) * f) as [number, number, number]));
}
/** Office-style columns: base colour + 5 lighter / darker variants. */
export function themeColumns(): string[][] {
  return THEME_BASE.map((base) => {
    if (base === '#FFFFFF') return [base, ...[0.05, 0.15, 0.25, 0.35, 0.5].map((f) => mix(base, 0, f))];
    if (base === '#000000') return [base, ...[0.5, 0.35, 0.25, 0.15, 0.05].map((f) => mix(base, 255, f))];
    return [base, mix(base, 255, 0.8), mix(base, 255, 0.6), mix(base, 255, 0.4), mix(base, 0, 0.25), mix(base, 0, 0.5)];
  });
}

export function rgbToHsv(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
export function hsvToHex(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

/** Resolve any CSS colour (names, rgb(), #abc) to #RRGGBB, or null. */
let ctx: CanvasRenderingContext2D | null = null;
export function toHex(c: string | undefined | null): string | null {
  if (!c) return null;
  const direct = hexToRgb(c);
  if (direct) return rgbToHex(...direct);
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#010203';
  ctx.fillStyle = c;
  const v = String(ctx.fillStyle);
  if (v === '#010203' && c.toLowerCase() !== '#010203') return null;
  if (v.startsWith('#')) return v.toUpperCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v);
  if (!m || m[4] === '0') return null;
  return rgbToHex(+m[1], +m[2], +m[3]);
}

const RECENT_KEY = 'reporttool.recentColors';
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 10) : [];
  } catch {
    return [];
  }
}
export const recentColors = ref<string[]>(loadRecent());
export function addRecent(hex: string) {
  const h = toHex(hex);
  if (!h) return;
  recentColors.value = [h, ...recentColors.value.filter((x) => x !== h)].slice(0, 10);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors.value));
  } catch {
    /* storage unavailable */
  }
}
