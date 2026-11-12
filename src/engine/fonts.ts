// Google Fonts: catalog, on-demand loading (text is measured only after the font has arrived), small previews for the
// font picker, and @font-face CSS with embedded font data for SVG -> PNG rendering.
import { ref } from 'vue';
import type { ReportDef, StyleProps } from '../model/types';
import { clearMeasureCache } from './measure';

export type FontCategory = 'Khmer' | 'Sans serif' | 'Serif' | 'Monospace' | 'Display' | 'Handwriting' | 'Thai / Lao';
export interface WebFont {
  family: string;
  cat: FontCategory;
  /** has a real bold (700) weight */
  bold: boolean;
}

const F = (cat: FontCategory, bold: boolean, ...families: string[]): WebFont[] => families.map((family) => ({ family, cat, bold }));

/** Popular Google Fonts (any other Google font can be typed in the font picker). */
export const GOOGLE_FONTS: WebFont[] = [
  ...F('Khmer', true, 'Kantumruy Pro', 'Noto Sans Khmer', 'Noto Serif Khmer', 'Battambang', 'Hanuman', 'Content', 'Nokora', 'Suwannaphum'),
  ...F('Khmer', false, 'Siemreap', 'Moul', 'Moulpali', 'Koulen', 'Bayon', 'Dangrek', 'Preahvihear', 'Angkor', 'Bokor', 'Kdam Thmor Pro', 'Metal', 'Odor Mean Chey', 'Taprom', 'Chenla', 'Freehand', 'Fasthand', 'Khmer'),
  ...F('Sans serif', true, 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Inter', 'Noto Sans', 'Source Sans 3', 'Nunito', 'Raleway', 'Work Sans', 'PT Sans', 'Ubuntu', 'Rubik', 'Barlow', 'Mulish', 'Fira Sans', 'IBM Plex Sans', 'Oswald', 'Roboto Condensed', 'Arimo', 'Cabin', 'Quicksand', 'Kanit', 'Prompt', 'Manrope', 'DM Sans', 'Lexend'),
  ...F('Serif', true, 'Roboto Slab', 'Merriweather', 'Playfair Display', 'Lora', 'PT Serif', 'Noto Serif', 'Libre Baskerville', 'EB Garamond', 'Crimson Text', 'Source Serif 4', 'Tinos', 'Bitter'),
  ...F('Monospace', true, 'Roboto Mono', 'Source Code Pro', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Cousine', 'Inconsolata', 'Space Mono'),
  ...F('Display', false, 'Bebas Neue', 'Anton', 'Lobster', 'Abril Fatface', 'Alfa Slab One'),
  ...F('Handwriting', true, 'Dancing Script', 'Caveat'),
  ...F('Handwriting', false, 'Pacifico', 'Great Vibes', 'Satisfy'),
  ...F('Thai / Lao', true, 'Sarabun', 'Noto Sans Thai', 'Noto Sans Lao'),
];
const CATALOG = new Map(GOOGLE_FONTS.map((f) => [f.family.toLowerCase(), f]));

/** Fonts installed on most computers (no download). */
export const SYSTEM_FONTS = ['Arial', 'Helvetica', 'Segoe UI', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Consolas', 'Khmer OS', 'Khmer UI', 'Leelawadee UI'];
const SYSTEM = new Set(SYSTEM_FONTS.map((f) => f.toLowerCase()));

/** Bumped whenever a web font has finished loading: designer views re-measure and re-draw. */
export const fontEpoch = ref(0);

const cssText = new Map<string, Promise<string | null>>();
const loaded = new Map<string, Promise<boolean>>();
/** Families that turned out not to exist on Google Fonts. */
const missing = new Set<string>();

export const isGoogleFont = (family: string | undefined, extra: string[] = []) =>
  !!family && !SYSTEM.has(family.toLowerCase()) && (CATALOG.has(family.toLowerCase()) || extra.some((x) => x.toLowerCase() === family.toLowerCase()) || loaded.has(family));

const cssUrl = (family: string, weights: boolean) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}${weights ? ':wght@400;700' : ''}&display=swap`;

/** The Google Fonts stylesheet of a family (regular + bold when available); null when it does not exist. */
function fetchCss(family: string): Promise<string | null> {
  let p = cssText.get(family);
  if (!p) {
    p = (async () => {
      const known = CATALOG.get(family.toLowerCase());
      // regular + bold first; a family without a bold weight answers that with an error -> regular only
      for (const weights of known && !known.bold ? [false] : [true, false]) {
        try {
          const res = await fetch(cssUrl(family, weights));
          if (res.ok) return await res.text();
        } catch {
          /* error answers carry no CORS header and arrive as a network error: try the next form */
        }
      }
      return null;
    })();
    cssText.set(family, p);
  }
  return p;
}

/** Load a Google font into the page; resolves true when it can be used. */
export function loadGoogleFont(family: string): Promise<boolean> {
  let p = loaded.get(family);
  if (!p) {
    p = (async () => {
      const css = await fetchCss(family);
      if (!css) {
        missing.add(family);
        return false;
      }
      const st = document.createElement('style');
      st.dataset.googleFont = family;
      st.textContent = css;
      document.head.appendChild(st);
      // fetch the faces needed for Latin and Khmer text, regular and bold
      const sample = 'AaZz09 ក ខ ក្ស';
      await Promise.all([document.fonts.load(`16px "${family}"`, sample), document.fonts.load(`bold 16px "${family}"`, sample)]).catch(() => undefined);
      clearMeasureCache();
      fontEpoch.value++;
      return true;
    })();
    loaded.set(family, p);
    p.then((ok) => {
      if (!ok) loaded.delete(family);
    });
  }
  return p;
}
export const fontMissing = (family: string) => missing.has(family);

/** Font families used by a report (base style, named styles, controls, table cells, format rules). */
export function usedFamilies(r: ReportDef): Set<string> {
  const out = new Set<string>();
  const add = (s?: StyleProps) => {
    if (s?.fontFamily) out.add(s.fontFamily);
  };
  add(r.baseStyle);
  r.styles.forEach((s) => add(s.style));
  for (const el of r.elements) {
    add(el.style);
    el.formatRules?.forEach((f) => add(f.style));
    if (el.type === 'table') el.rows.forEach((row) => row.cells.forEach((c) => add(c.style)));
  }
  return out;
}

/** Load every Google font the report uses (call before measuring / rendering). */
export async function ensureReportFonts(r: ReportDef): Promise<void> {
  const fams = [...usedFamilies(r)].filter((f) => isGoogleFont(f, r.fonts ?? []));
  if (fams.length) await Promise.all(fams.map(loadGoogleFont));
}

/**
 * Preview of a font name in its own font (font picker). Uses the family's normal stylesheet under another family
 * name, so nothing changes for the report until the font is chosen; the browser only downloads the face needed for
 * the letters of the name (unicode-range).
 */
const previews = new Set<string>();
export const previewFamily = (family: string) => family + ' preview';
export function loadFontPreview(family: string) {
  if (previews.has(family) || SYSTEM.has(family.toLowerCase()) || loaded.has(family)) return;
  previews.add(family);
  void fetchCss(family).then((css) => {
    if (!css) return;
    const st = document.createElement('style');
    st.textContent = css.replace(/font-family:\s*'[^']*'/g, `font-family: '${previewFamily(family)}'`);
    document.head.appendChild(st);
  });
}

/** Google Fonts stylesheet links for an HTML page (families that are web fonts). */
export function googleFontsLink(families: Iterable<string>, extra: string[] = []): string {
  const list = [...new Set(families)].filter((f) => isGoogleFont(f, extra));
  if (!list.length) return '';
  const fam = list.map((f) => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + (CATALOG.get(f.toLowerCase())?.bold ? ':wght@400;700' : '')).join('&');
  return `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fam}&display=swap">`;
}

/** @font-face rules with the font files embedded (SVG rendered as an image cannot load fonts itself). */
const embedded = new Map<string, Promise<string>>();
export function embeddedFontCss(families: Iterable<string>): Promise<string> {
  const jobs = [...new Set(families)]
    .filter((f) => loaded.has(f))
    .map((f) => {
      let p = embedded.get(f);
      if (!p) {
        p = (async () => {
          const css = (await fetchCss(f)) ?? '';
          const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))];
          let out = css;
          for (const u of urls) {
            try {
              const blob = await (await fetch(u)).blob();
              const data = await new Promise<string>((res) => {
                const fr = new FileReader();
                fr.onload = () => res(String(fr.result));
                fr.readAsDataURL(blob);
              });
              out = out.split(u).join(data);
            } catch {
              /* keep the remote URL */
            }
          }
          return out;
        })();
        embedded.set(f, p);
      }
      return p;
    });
  return Promise.all(jobs).then((parts) => parts.join('\n'));
}
