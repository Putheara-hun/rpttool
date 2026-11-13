// Excel (XLSX) and CSV export. Text boxes of the rendered document are mapped to a grid (WYSIWYG mode).
import { strToU8, zipSync } from 'fflate';
import type { CellInfo, PImage, PSvg, RenderedDoc } from '../engine/doc';
import { isDate } from '../engine/format';
import { escXml } from './svg';
import { lookOf, makeGrid, pageDecor, type Edge, type GridCell as Box, type Placed } from './pagegrid';
import { picturePng } from './inline';

interface GridCell {
  text: string;
  value: unknown;
  bold: boolean;
  /** last grid column covered by the cell (merged / wide cells) */
  endCol: number;
}

function cluster(values: number[], tol: number): number[] {
  const s = [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}
const indexOf = (anchors: number[], v: number) => {
  let best = 0;
  for (let i = 0; i < anchors.length; i++) if (anchors[i] <= Math.round(v) + 0.5) best = i;
  return best;
};

export function buildGrid(doc: RenderedDoc): { rows: GridCell[][]; colWidths: number[] } {
  const all: (CellInfo & { gy: number })[] = [];
  let offset = 0;
  doc.pages.forEach((p, pi) => {
    for (const c of p.cells) {
      if ((c.band === 'pageHeader' && pi > 0) || c.band === 'pageFooter') continue;
      all.push({ ...c, gy: offset + c.y });
    }
    offset += p.height;
  });
  const xs = cluster(
    all.map((c) => c.x),
    3,
  );
  const ys = cluster(
    all.map((c) => c.gy),
    2,
  );
  const rows: GridCell[][] = ys.map(() => []);
  for (const c of all) {
    const r = indexOf(ys, c.gy);
    const col = indexOf(xs, c.x);
    // a cell wider than its column (merged table cells) covers the following grid columns
    let endCol = col;
    while (endCol + 1 < xs.length && xs[endCol + 1] < c.x + c.w - 3) endCol++;
    const ex = rows[r][col];
    if (ex) ex.text += ' ' + c.text;
    else rows[r][col] = { text: c.text, value: c.value, bold: !!c.bold, endCol };
  }
  // never let a wide cell run over another cell of the same row
  for (const row of rows)
    row.forEach((c, i) => {
      if (!c) return;
      for (let k = i + 1; k <= c.endCol; k++)
        if (row[k]) {
          c.endCol = k - 1;
          break;
        }
    });
  const colWidths = xs.map((x, i) => (i + 1 < xs.length ? xs[i + 1] - x : 120));
  return { rows: rows.filter((r) => r.some((c) => c && c.text !== '')), colWidths };
}

const colName = (i: number) => {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

const excelDate = (d: Date) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - Date.UTC(1899, 11, 30)) / 86400000;

const quoteLit = (s: string) => (s ? '"' + s.replace(/"/g, '') + '"' : '');

/**
 * The Excel number format that shows `v` exactly as the report text does ("5,000,000.00", "12.5%", "$ 1,200",
 * "(300.00)", "000123"); null when the text is not that number (then the text is written as it is).
 */
export function excelNumberFormat(text: string, v: number): string | null {
  const t = text.trim();
  const m = /^([^\d]*?)(\d(?:[\d.,\s  ]*\d)?)([^\d]*)$/.exec(t);
  if (!m) return null;
  let [, pre, num, suf] = m;
  const neg = v < 0;
  const paren = neg && /\($/.test(pre) && /^\)/.test(suf);
  if (paren) {
    pre = pre.slice(0, -1);
    suf = suf.slice(1);
  } else if (neg) {
    if (/[-−]\s*$/.test(pre)) pre = pre.replace(/[-−]\s*$/, '');
    else if (/^[-−]/.test(pre)) pre = pre.slice(1);
    else return null;
  } else if (/[-−(]/.test(pre)) return null;
  // decimal separator: the last of "." / "," — alone it is a thousands separator when 3 digits follow a whole number
  const lastDot = num.lastIndexOf('.');
  const lastComma = num.lastIndexOf(',');
  let dec = '';
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    const s = lastDot >= 0 ? '.' : ',';
    const once = num.indexOf(s) === num.lastIndexOf(s);
    const after = num.length - num.lastIndexOf(s) - 1;
    if (once && (after !== 3 || !Number.isInteger(v))) dec = s;
  }
  const at = dec ? num.lastIndexOf(dec) : num.length;
  const intPart = num.slice(0, at);
  const decimals = dec ? num.length - at - 1 : 0;
  const grouped = /[.,\s  ]/.test(intPart);
  const digits = (intPart + num.slice(at + 1)).replace(/\D/g, '');
  const same = (x: number) => Math.abs(x).toFixed(decimals).replace('.', '').replace(/^0+/, '') === digits.replace(/^0+/, '');
  const intDigits = intPart.replace(/\D/g, '');
  const body = (!grouped && intDigits.length > 1 && intDigits.startsWith('0') ? '0'.repeat(intDigits.length) : grouped ? '#,##0' : '0') + (decimals ? '.' + '0'.repeat(decimals) : '');
  let fmt: string;
  if (/%/.test(suf) && same(v * 100)) fmt = quoteLit(pre) + body + quoteLit(suf.replace('%', '')) + '%';
  else if (same(v)) fmt = quoteLit(pre) + body + quoteLit(suf);
  else return null;
  return paren ? `${fmt};(${fmt})` : fmt;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** the Excel date format that shows `d` as the report text does ("31/10/2026", "Oct 31, 2026 14:05"); null = unknown */
export function excelDateFormat(text: string, d: Date): string | null {
  const toks = text.trim().match(/\d+|[A-Za-z]+|[^\dA-Za-z]+/g);
  if (!toks || /\b[ap]\.m\./i.test(text)) return null;
  const used = new Set<string>();
  const pm = toks.some((t) => /^[ap]m$/i.test(t));
  const hour = pm ? d.getHours() % 12 || 12 : d.getHours();
  let out = '';
  let parts = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      const two = t.length === 2;
      const short = t.length <= 2;
      // a number before ":" is the hour; after the hour come minutes, then seconds
      const time = used.has('h') || toks[i + 1]?.startsWith(':');
      let code: string;
      if (time && !used.has('h') && short && n === hour) code = 'hh';
      else if (time && used.has('h') && !used.has('n') && two && n === d.getMinutes()) code = 'nn';
      else if (time && used.has('n') && !used.has('s') && two && n === d.getSeconds()) code = 'ss';
      else if (time) return null;
      else if (!used.has('y') && t.length === 4 && n === d.getFullYear()) code = 'yyyy';
      else if (!used.has('d') && short && n === d.getDate()) code = 'dd';
      else if (!used.has('m') && short && n === d.getMonth() + 1) code = 'mm';
      else if (!used.has('y') && two && n === d.getFullYear() % 100) code = 'yy';
      else return null;
      used.add(code[0]);
      parts++;
      // dd / mm / hh: two digits as in the text, one digit otherwise; nn = minutes ("mm" after the hour)
      out += code === 'nn' ? 'mm' : code === 'yyyy' || code === 'yy' || code === 'ss' ? code : two ? code : code[0];
    } else if (/^[A-Za-z]+$/.test(t)) {
      const l = t.toLowerCase();
      const month = MONTHS[d.getMonth()];
      const day = DAYS[d.getDay()];
      if (l === month) out += 'mmmm';
      else if (l === month.slice(0, 3)) out += 'mmm';
      else if (l === day) out += 'dddd';
      else if (l === day.slice(0, 3)) out += 'ddd';
      else if (/^[ap]m$/.test(l)) out += 'AM/PM';
      else out += quoteLit(t);
      if (l === month || l === month.slice(0, 3)) {
        used.add('m');
        parts++;
      }
    } else out += /^[\s/\-:,.]+$/.test(t) ? t : quoteLit(t);
  }
  return parts ? out : null;
}

/** Excel border style for a line of `w` px */
function xlBorder(e: Edge | undefined): string {
  if (!e) return '';
  const st =
    e.ls === 'dotted' ? 'dotted' : e.ls === 'dashed' ? (e.width > 1.25 ? 'mediumDashed' : 'dashed') : e.width < 0.75 ? 'hair' : e.width <= 1.25 ? 'thin' : e.width <= 2.25 ? 'medium' : 'thick';
  return ` style="${st}"><color rgb="FF${e.color}"/`;
}

const PAPER: [number, number, number][] = [
  [9, 793.7, 1122.5], // A4
  [1, 816, 1056], // Letter
  [5, 816, 1344], // Legal
  [8, 1122.5, 1587.4], // A3
  [11, 559.4, 793.7], // A5
];

export interface XlsxOptions {
  /** page margins of the report (px) — used for printing the sheet */
  margins?: { top: number; right: number; bottom: number; left: number };
}

/**
 * Excel workbook that looks like the preview: fonts, colours, fills, borders, alignment, column widths, row heights and
 * merged cells; numbers and dates stay numbers and dates, shown with the report's format. Pages follow one another
 * (page headers once, no page footers); pictures and charts are placed where they are on the page.
 */
export async function exportXlsx(doc: RenderedDoc, sheetName = 'Report', opts: XlsxOptions = {}): Promise<Blob> {
  // ---- boxes of all pages, one after another
  const items: Placed[] = [];
  const pageTop: number[] = [];
  // pictures and charts in the sheet: not in the page footer, not the page header again, not the same one twice
  const pictures: { q: PImage | PSvg; page: number; gy: number }[] = [];
  const seen = new Set<string>();
  let offset = 0;
  doc.pages.forEach((p, pi) => {
    pageTop[pi] = offset;
    const cells = p.cells.filter((c) => !c.repeat && !(c.band === 'pageHeader' && pi > 0) && c.band !== 'pageFooter');
    const deco = pageDecor(p, cells);
    for (const c of cells) {
      const d = deco.get(c)!;
      if (c.text === '' && !d.fill && !d.t && !d.b && !d.l && !d.r) continue;
      items.push({ c, page: pi, top: offset + c.y, deco: d });
    }
    const footerTop = Math.min(...p.cells.filter((c) => c.band === 'pageFooter').map((c) => c.y), Infinity);
    const headerBottom = pi > 0 ? Math.max(...p.cells.filter((c) => c.band === 'pageHeader').map((c) => c.y + c.h), -Infinity) : -Infinity;
    for (const q of p.prims) {
      if (q.k !== 'image' && q.k !== 'svg') continue;
      const key = (q.k === 'image' ? q.src.slice(0, 200) + q.src.length : q.svg.length + q.svg.slice(0, 200)) + `|${Math.round(q.x)}|${Math.round(q.y)}|${Math.round(q.w)}|${Math.round(q.h)}`;
      const again = seen.has(key);
      seen.add(key);
      if (again || q.y >= footerTop - 0.5 || q.y + q.h <= headerBottom + 0.5) continue;
      pictures.push({ q, page: pi, gy: offset + q.y });
      // the picture takes room in the grid (rows / columns at its edges), also where there is no text around it
      items.push({ c: { x: q.x, y: q.y, w: q.w, h: q.h, text: '', value: '', band: '' }, page: pi, top: offset + q.y, deco: {}, ghost: true });
    }
    offset += p.height;
  });
  const grid = makeGrid(items);

  // ---- styles (each distinct look once)
  const fonts: string[] = ['<font><sz val="10"/><name val="Arial"/></font>'];
  const fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts: string[] = [];
  const xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  // one map for all lists: their entries never look alike (<font…>, <fill…>, <border…>, <xf…>)
  const ids = new Map<string, number>();
  const idOf = (list: string[], xml: string) => {
    let i = ids.get(xml);
    if (i === undefined) {
      i = list.length;
      list.push(xml);
      ids.set(xml, i);
    }
    return i;
  };
  const fmtId = (code: string) => {
    const xml = `<numFmt numFmtId="@" formatCode="${escXml(code)}"/>`;
    let i = ids.get(xml);
    if (i === undefined) {
      i = 164 + numFmts.length;
      numFmts.push(xml.replace('"@"', `"${i}"`));
      ids.set(xml, i);
    }
    return i;
  };
  const styleOf = (g: Box, numFmt: number) => {
    const lk = lookOf(g.c, doc.pages[g.page]);
    const font = idOf(
      fonts,
      `<font>${lk.bold ? '<b/>' : ''}${lk.italic ? '<i/>' : ''}${lk.strike ? '<strike/>' : ''}${lk.underline ? '<u/>' : ''}<sz val="${+lk.size.toFixed(1)}"/><color rgb="FF${lk.color}"/><name val="${escXml(
        lk.family.replace(/["']/g, '').slice(0, 31),
      )}"/></font>`,
    );
    const d = g.deco;
    const fill = d.fill ? idOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${d.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (n: string, e: Edge | undefined) => (e ? `<${n}${xlBorder(e)}></${n}>` : `<${n}/>`);
    const border = d.t || d.b || d.l || d.r ? idOf(borders, `<border>${side('left', d.l)}${side('right', d.r)}${side('top', d.t)}${side('bottom', d.b)}<diagonal/></border>`) : 0;
    const v = lk.vAlign === 'middle' ? 'center' : lk.vAlign;
    const xml = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${lk.align}" vertical="${v}"${
      lk.wrap ? ' wrapText="1"' : ''
    }/></xf>`;
    return idOf(xfs, xml);
  };

  // ---- cells
  const rowCells: string[][] = grid.rows.map(() => []);
  const merges: string[] = [];
  for (const g of grid.cells) {
    const ref = colName(g.col) + (g.row + 1);
    const v = g.c.value;
    let xml: string;
    let s: number;
    const num = typeof v === 'number' && isFinite(v) && g.text !== '' && g.text === g.c.text ? excelNumberFormat(g.text, v) : null;
    const date = !num && isDate(v) && !isNaN(v.getTime()) && g.text !== '' && g.text === g.c.text ? excelDateFormat(g.text, v) : null;
    if (num !== null) {
      s = styleOf(g, fmtId(num));
      xml = `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
    } else if (date !== null) {
      s = styleOf(g, fmtId(date));
      xml = `<c r="${ref}" s="${s}"><v>${excelDate(v as Date)}</v></c>`;
    } else {
      s = styleOf(g, 0);
      xml = g.text === '' ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escXml(g.text)}</t></is></c>`;
    }
    rowCells[g.row].push(`${String(g.col).padStart(6, '0')}${xml}`);
    if (g.endCol > g.col || g.endRow > g.row) {
      merges.push(`<mergeCell ref="${ref}:${colName(g.endCol)}${g.endRow + 1}"/>`);
      // the covered cells carry the same look, so the merged area shows its fill and all its borders
      for (let r = g.row; r <= g.endRow; r++)
        for (let k = g.col; k <= g.endCol; k++) if (r !== g.row || k !== g.col) rowCells[r].push(`${String(k).padStart(6, '0')}<c r="${colName(k)}${r + 1}" s="${s}"/>`);
    }
  }
  const sheetRows = grid.rows.map((r, i) => {
    const cells = rowCells[i]
      .sort()
      .map((x) => x.slice(6))
      .join('');
    return `<row r="${i + 1}" ht="${+(r.height * 0.75).toFixed(2)}" customHeight="1">${cells}</row>`;
  });
  const cols = grid.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(0.5, (w - 5) / 7).toFixed(2)}" customWidth="1"/>`).join('');

  // ---- pictures and charts, where they are on the page
  const pics: { col: number; colOff: number; row: number; rowOff: number; w: number; h: number; png: Uint8Array }[] = [];
  for (const { q, page, gy } of pictures) {
    const rows = grid.rows.map((r, i) => ({ ...r, i })).filter((r) => r.page === page);
    if (!rows.length) continue;
    let row = rows[0];
    for (const r of rows) if (r.top <= gy + 0.5) row = r;
    let col = 0;
    grid.xs.forEach((x, i) => x <= q.x + 0.5 && (col = i));
    const png = await picturePng(q);
    if (png) pics.push({ col, colOff: Math.max(0, q.x - (grid.xs[col] ?? 0)), row: row.i, rowOff: Math.max(0, gy - row.top), w: q.w, h: q.h, png });
  }

  // ---- printing: the report's paper, margins and orientation, fit to the page width
  const p0 = doc.pages[0];
  const paper = p0 ? PAPER.find(([, w, h]) => (Math.abs(w - p0.width) < 3 && Math.abs(h - p0.height) < 3) || (Math.abs(h - p0.width) < 3 && Math.abs(w - p0.height) < 3)) : undefined;
  const mg = opts.margins ?? { top: 48, right: 48, bottom: 48, left: 48 };
  const inch = (px: number) => +(Math.max(0, px) / 96).toFixed(3);
  const EMU = 9525;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${
    cols ? `<cols>${cols}</cols>` : ''
  }<sheetData>${sheetRows.join('')}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : ''}<pageMargins left="${inch(mg.left)}" right="${inch(mg.right)}" top="${inch(
    mg.top,
  )}" bottom="${inch(mg.bottom)}" header="0" footer="0"/><pageSetup${paper ? ` paperSize="${paper[0]}"` : ''} orientation="${p0 && p0.width > p0.height ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>${
    pics.length ? '<drawing r:id="rId1"/>' : ''
  }</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : ''}<fonts count="${fonts.length}">${fonts.join(
    '',
  )}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join(
    '',
  )}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join(
    '',
  )}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const safeName = escXml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
      pics.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''
    }</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(styles),
  };
  if (pics.length) {
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
    const anchors = pics.map(
      (p, i) =>
        `<xdr:oneCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>${Math.round(p.colOff * EMU)}</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>${Math.round(p.rowOff * EMU)}</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(
          p.w * EMU,
        )}" cy="${Math.round(p.h * EMU)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="Picture ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${
          i + 1
        }"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(p.w * EMU)}" cy="${Math.round(
          p.h * EMU,
        )}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`,
    );
    files['xl/drawings/drawing1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join(
      '',
    )}</xdr:wsDr>`);
    files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pics
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/>`)
      .join('')}</Relationships>`);
    pics.forEach((p, i) => (files[`xl/media/image${i + 1}.png`] = p.png));
  }
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function exportCsv(doc: RenderedDoc): Blob {
  const { rows } = buildGrid(doc);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const q = (s: string) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const lines = rows.map((r) => Array.from({ length: width }, (_, i) => q(r[i]?.text ?? '')).join(','));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
