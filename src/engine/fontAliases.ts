// Khmer OS fonts (installed on many Khmer Windows computers and used in SSRS / Report Builder reports) and the free
// Google Fonts made from the same designs (by Danh Hong). A report keeps the Khmer OS name (SSRS servers have that
// font); browsers without it installed draw the Google version instead of a plain fallback font.
const WEB_FALLBACK: Record<string, string> = {
  'khmer os battambang': 'Battambang',
  'khmer os siemreap': 'Siemreap',
  'khmer os content': 'Content',
  'khmer os bokor': 'Bokor',
  'khmer os metal chrieng': 'Metal',
  'khmer os freehand': 'Freehand',
  'khmer os fasthand': 'Fasthand',
  'khmer os muol': 'Moul',
  'khmer os muol light': 'Moul',
  'khmer os muol pali': 'Moulpali',
};

/** Khmer OS font names with a Google Fonts version, as shown in the font picker. */
export const KHMER_OS_FONTS = ['Khmer OS Battambang', 'Khmer OS Siemreap', 'Khmer OS Content', 'Khmer OS Bokor', 'Khmer OS Metal Chrieng', 'Khmer OS Freehand', 'Khmer OS Fasthand', 'Khmer OS Muol Light', 'Khmer OS Muol Pali'];

/** Google Fonts family used when `family` is not installed (undefined = no such stand-in). */
export const webFallback = (family?: string): string | undefined => (family ? WEB_FALLBACK[family.trim().toLowerCase()] : undefined);

/** Khmer OS names whose Google stand-in is `google` (font picker: search "Khmer OS Battambang" finds Battambang). */
export const khmerOsNamesOf = (google: string): string[] => KHMER_OS_FONTS.filter((k) => webFallback(k)?.toLowerCase() === google.toLowerCase());

/** CSS font-family list: the font, its Google stand-in (if any), then Arial. `q` = quote character. */
export function familyList(family: string, q = '"'): string {
  const name = (f: string) => q + f.replace(/["']/g, '') + q;
  const fb = webFallback(family);
  return [name(family), ...(fb ? [name(fb)] : []), 'Arial', 'sans-serif'].join(', ');
}
