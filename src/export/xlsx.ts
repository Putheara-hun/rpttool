// Excel (XLSX) and CSV export. Text boxes of the rendered document are mapped to a grid (WYSIWYG mode).
import { strToU8, zipSync } from 'fflate';
import type { CellInfo, RenderedDoc } from '../engine/doc';
import { isDate } from '../engine/format';
import { escXml } from './svg';

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

export function exportXlsx(doc: RenderedDoc, sheetName = 'Report'): Blob {
  const { rows, colWidths } = buildGrid(doc);
  // styles: 0 normal, 1 bold, 2 date, 3 bold date, 4 number #,##0.00, 5 bold number, 6 percent, 7 bold percent
  const sheetRows: string[] = [];
  const merges: string[] = [];
  rows.forEach((row, ri) => {
    const cells: string[] = [];
    row.forEach((c, ci) => {
      if (!c || c.text === '') return;
      const ref = colName(ci) + (ri + 1);
      if (c.endCol > ci) merges.push(`<mergeCell ref="${ref}:${colName(c.endCol)}${ri + 1}"/>`);
      const b = c.bold ? 1 : 0;
      const v = c.value;
      if (typeof v === 'number' && isFinite(v)) {
        const s = c.text.includes('%') ? 6 + b : /[.,]\d\d$/.test(c.text.replace(/[^\d.,]/g, '')) ? 4 + b : b;
        cells.push(`<c r="${ref}" s="${s}"><v>${v}</v></c>`);
      } else if (isDate(v)) {
        cells.push(`<c r="${ref}" s="${2 + b}"><v>${excelDate(v)}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" s="${b}" t="inlineStr"><is><t xml:space="preserve">${escXml(c.text)}</t></is></c>`);
      }
    });
    sheetRows.push(`<row r="${ri + 1}">${cells.join('')}</row>`);
  });
  const cols = colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(80, w / 7)).toFixed(1)}" customWidth="1"/>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${sheetRows.join('')}</sheetData>${
    merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : ''
  }</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs></styleSheet>`;
  const safeName = escXml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(styles),
  };
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function exportCsv(doc: RenderedDoc): Blob {
  const { rows } = buildGrid(doc);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const q = (s: string) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const lines = rows.map((r) => Array.from({ length: width }, (_, i) => q(r[i]?.text ?? '')).join(','));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
