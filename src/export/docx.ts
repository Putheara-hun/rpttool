// Word (DOCX) export: every report page is a Word page with a table laid out like the preview — fonts (Khmer too),
// colours, fills, borders, alignment, column widths and row heights — and its pictures / charts where they are.
import { strToU8, zipSync } from 'fflate';
import type { RenderedDoc, RenderedPage } from '../engine/doc';
import { lineHeight } from '../engine/measure';
import { escXml } from './svg';
import { picturePng } from './inline';
import { lookOf, looseText, makeGrid, pageDecor, type Edge, type Grid, type GridCell, type Placed } from './pagegrid';

const TW = 15; // twips per px (1px = 0.75pt = 15 twentieths of a point)
const EMU = 9525; // EMU per px
const tw = (px: number) => Math.max(0, Math.round(px * TW));
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const esc = (s: string) => escXml(s.replace(XML_BAD, ''));
const KHMER = /[ក-៿᧠-᧿]/;

function wBorder(side: string, e: Edge | undefined): string {
  if (!e) return '';
  const val = e.ls === 'dotted' ? 'dotted' : e.ls === 'dashed' ? 'dashed' : 'single';
  const sz = Math.max(2, Math.min(96, Math.round(e.width * 6))); // eighths of a point
  return `<w:${side} w:val="${val}" w:sz="${sz}" w:space="0" w:color="${e.color}"/>`;
}

/** an empty paragraph that takes (almost) no height — empty cells must not make a row taller */
const TINY_P = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>';

function cellXml(g: GridCell | null, span: number, width: number, page: RenderedPage, opts: { vMerge?: 'restart' | 'continue' } = {}): string {
  const d = g?.deco;
  const borders = d ? wBorder('top', d.t) + wBorder('left', d.l) + wBorder('bottom', d.b) + wBorder('right', d.r) : '';
  const lk = g ? lookOf(g.c, page) : null;
  const pad = lk ? tw(lk.padding) : 0;
  const tcPr =
    `<w:tcPr><w:tcW w:w="${tw(width)}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${opts.vMerge ? `<w:vMerge${opts.vMerge === 'restart' ? ' w:val="restart"' : ''}/>` : ''}` +
    `${borders ? `<w:tcBorders>${borders}</w:tcBorders>` : ''}${d?.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${d.fill}"/>` : ''}${lk && !lk.wrap ? '<w:noWrap/>' : ''}` +
    `<w:tcMar><w:top w:w="${pad}" w:type="dxa"/><w:left w:w="${pad}" w:type="dxa"/><w:bottom w:w="${pad}" w:type="dxa"/><w:right w:w="${pad}" w:type="dxa"/></w:tcMar>` +
    `${lk ? `<w:vAlign w:val="${lk.vAlign === 'middle' ? 'center' : lk.vAlign}"/>` : ''}</w:tcPr>`;
  if (!g || !lk || opts.vMerge === 'continue' || g.text === '') return `<w:tc>${tcPr}${TINY_P}</w:tc>`;
  const lh = lineHeight({ family: lk.family, size: lk.size, bold: lk.bold, italic: lk.italic });
  const fam = esc(lk.family.replace(/["']/g, ''));
  const half = Math.max(2, Math.round(lk.size * 2));
  const rPr =
    `<w:rPr><w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:eastAsia="${fam}" w:cs="${fam}"/>${lk.bold ? '<w:b/><w:bCs/>' : ''}${lk.italic ? '<w:i/><w:iCs/>' : ''}${lk.strike ? '<w:strike/>' : ''}` +
    `<w:color w:val="${lk.color}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/>${lk.underline ? '<w:u w:val="single"/>' : ''}${KHMER.test(g.text) ? '<w:lang w:bidi="km-KH"/>' : ''}</w:rPr>`;
  const jc = lk.align === 'justify' ? 'both' : lk.align;
  const runs = g.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((ln, i) => `${i ? `<w:r>${rPr}<w:br/></w:r>` : ''}<w:r>${rPr}<w:t xml:space="preserve">${esc(ln)}</w:t></w:r>`)
    .join('');
  // line height exactly as in the preview: Word's own (taller for Khmer fonts) would push the rows down
  const p = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.max(20, tw(lh))}" w:lineRule="exact"/><w:jc w:val="${jc}"/>${rPr}</w:pPr>${runs}</w:p>`;
  return `<w:tc>${tcPr}${p}</w:tc>`;
}

function tableXml(grid: Grid, page: RenderedPage, left: number, lead: number): string {
  const n = grid.xs.length;
  const owners = new Map<string, GridCell>(); // every grid spot -> the cell covering it
  for (const g of grid.cells) for (let r = g.row; r <= g.endRow; r++) for (let k = g.col; k <= g.endCol; k++) owners.set(r + ',' + k, g);
  const width = (a: number, b: number) => grid.colWidths.slice(a, b + 1).reduce((s, w) => s + w, 0);
  const rows: string[] = [];
  if (lead > 0.5) rows.push(`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(lead)}" w:hRule="exact"/></w:trPr>${cellXml(null, n, width(0, n - 1), page)}</w:tr>`);
  grid.rows.forEach((row, r) => {
    const tcs: string[] = [];
    for (let k = 0; k < n; ) {
      const g = owners.get(r + ',' + k);
      if (g && g.col === k) {
        const span = g.endCol - g.col + 1;
        const vMerge = g.endRow > g.row ? (g.row === r ? 'restart' : 'continue') : undefined;
        tcs.push(cellXml(g, span, width(k, g.endCol), page, { vMerge }));
        k += span;
      } else {
        // free spots up to the next cell: one empty cell
        let e = k;
        while (e + 1 < n && !owners.has(r + ',' + (e + 1))) e++;
        tcs.push(cellXml(null, e - k + 1, width(k, e), page));
        k = e + 1;
      }
    }
    rows.push(`<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${Math.max(1, tw(row.height))}" w:hRule="atLeast"/></w:trPr>${tcs.join('')}</w:tr>`);
  });
  const total = width(0, n - 1);
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${tw(total)}" w:type="dxa"/><w:tblInd w:w="${tw(grid.xs[0] - left)}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000"/></w:tblPr>` +
    `<w:tblGrid>${grid.colWidths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`
  );
}

/** Word document: one Word page per report page */
export async function exportDocx(doc: RenderedDoc, title: string): Promise<Blob> {
  const p0 = doc.pages[0];
  const pageW = p0?.width ?? 793.7;
  const pageH = p0?.height ?? 1122.5;
  const grids = doc.pages.map((p, pi) => {
    const cells = [...p.cells, ...looseText(p)];
    const deco = pageDecor(p, cells);
    const items: Placed[] = [];
    for (const c of cells) {
      const d = deco.get(c)!;
      if (c.text === '' && !d.fill && !d.t && !d.b && !d.l && !d.r) continue;
      items.push({ c, page: pi, top: c.y, deco: d });
    }
    return makeGrid(items);
  });
  // margins: the content's own edges (each page's table is placed at its exact position below)
  const used = grids.filter((g) => g.rows.length);
  const left = used.length ? Math.max(0, Math.min(...used.map((g) => g.xs[0])) - 1) : 48;
  const right = used.length ? Math.max(0, pageW - Math.max(...used.map((g) => g.xs[g.xs.length - 1] + g.colWidths[g.colWidths.length - 1])) - 1) : 48;
  const top = used.length ? Math.max(0, Math.min(...used.map((g) => g.rows[0].top)) - 2) : 48;
  const bottomEdge = used.length ? Math.max(...used.map((g) => g.rows[g.rows.length - 1].top + g.rows[g.rows.length - 1].height)) : pageH - 48;
  // a little room below the content, so a page never spills onto an extra one
  const bottom = Math.max(0, pageH - bottomEdge - 8);
  const tinyH = 20 / TW; // the 1pt paragraph at the top of each page

  const media: Uint8Array[] = [];
  let drawId = 0;
  const body: string[] = [];
  for (let pi = 0; pi < doc.pages.length; pi++) {
    const p = doc.pages[pi];
    const grid = grids[pi];
    // pictures and charts: floating, at their exact place on the page
    const anchors: string[] = [];
    for (const q of p.prims) {
      if (q.k !== 'image' && q.k !== 'svg') continue;
      const png = await picturePng(q);
      if (!png) continue;
      media.push(png);
      const id = ++drawId;
      const cx = Math.round(q.w * EMU);
      const cy = Math.round(q.h * EMU);
      anchors.push(
        `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + id}" behindDoc="0" locked="0" layoutInCell="0" allowOverlap="1">` +
          `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:posOffset>${Math.round((q.x - left) * EMU)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="margin"><wp:posOffset>${Math.round((q.y - top) * EMU)}</wp:posOffset></wp:positionV>` +
          `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
          `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${media.length}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip r:embed="rImg${media.length}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
          `</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`,
      );
    }
    // a 1pt paragraph opens the page (it holds the pictures); "page break before" never makes an empty page
    body.push(
      `<w:p><w:pPr>${pi > 0 ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>${anchors.join('')}</w:p>`,
    );
    if (grid.rows.length) body.push(tableXml(grid, p, left, grid.rows[0].top - top - tinyH));
  }
  body.push(TINY_P);

  const landscape = pageW > pageH;
  const sect = `<w:sectPr><w:pgSz w:w="${tw(pageW)}" w:h="${tw(pageH)}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(top)}" w:right="${tw(right)}" w:bottom="${tw(bottom)}" w:left="${tw(
    left,
  )}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join(
    '',
  )}${sect}</w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(
      title || 'Report',
    )}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`),
    'word/document.xml': strToU8(documentXml),
    'word/styles.xml': strToU8(stylesXml),
    'word/settings.xml': strToU8(settingsXml),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${media
      .map((_, i) => `<Relationship Id="rImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`)
      .join('')}</Relationships>`),
  };
  media.forEach((m, i) => (files[`word/media/image${i + 1}.png`] = m));
  return new Blob([zipSync(files) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
