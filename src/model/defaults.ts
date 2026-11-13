import type {
  Band,
  BandType,
  CrosstabElement,
  DetailReportDef,
  ElementType,
  PageSettings,
  ReportDef,
  ReportElement,
  ResolvedStyle,
  StyleProps,
  TableCell,
  Watermark,
} from './types';
import { familyList } from '../engine/fontAliases';

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10);

export const MM = 96 / 25.4; // px per mm
export const mmToPx = (mm: number) => mm * MM;
export const pxToMm = (px: number) => px / MM;
export const PT = 96 / 72; // px per point

export const PAPER_SIZES: Record<string, { w: number; h: number; label: string; roll?: boolean }> = {
  A4: { w: 210, h: 297, label: 'A4 (210 x 297 mm)' },
  A3: { w: 297, h: 420, label: 'A3 (297 x 420 mm)' },
  A5: { w: 148, h: 210, label: 'A5 (148 x 210 mm)' },
  A6: { w: 105, h: 148, label: 'A6 (105 x 148 mm)' },
  B5: { w: 176, h: 250, label: 'B5 (176 x 250 mm)' },
  Letter: { w: 215.9, h: 279.4, label: 'Letter (8.5 x 11 in)' },
  Legal: { w: 215.9, h: 355.6, label: 'Legal (8.5 x 14 in)' },
  Executive: { w: 184.15, h: 266.7, label: 'Executive (7.25 x 10.5 in)' },
  Tabloid: { w: 279.4, h: 431.8, label: 'Tabloid (11 x 17 in)' },
  Receipt80: { w: 80, h: 200, label: 'Receipt roll 80 mm', roll: true },
  Receipt58: { w: 58, h: 160, label: 'Receipt roll 58 mm', roll: true },
};

/** Margin presets in mm. */
export const MARGIN_PRESETS: Record<string, { label: string; mm: number }> = {
  none: { label: 'None (0 mm)', mm: 0 },
  narrow: { label: 'Narrow (6.35 mm)', mm: 6.35 },
  normal: { label: 'Normal (12.7 mm)', mm: 12.7 },
  moderate: { label: 'Moderate (19 mm)', mm: 19.05 },
  wide: { label: 'Wide (25.4 mm)', mm: 25.4 },
};

export const FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Segoe UI',
  'Calibri',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Times New Roman',
  'Georgia',
  'Garamond',
  'Courier New',
  'Consolas',
  'Khmer OS',
  'Noto Sans',
];

export const BAND_LABELS: Record<BandType, string> = {
  reportHeader: 'Report Header',
  pageHeader: 'Page Header',
  groupHeader: 'Group Header',
  detail: 'Detail',
  groupFooter: 'Group Footer',
  reportFooter: 'Report Footer',
  pageFooter: 'Page Footer',
  drHeader: 'Header',
  drDetail: 'Detail',
  drFooter: 'Footer',
};

export const DEFAULT_BASE_STYLE: ResolvedStyle = {
  fontFamily: 'Arial',
  fontSize: 10,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: '#000000',
  backColor: '',
  textAlign: 'left',
  vAlign: 'top',
  padding: 2,
  borders: '',
  borderWidth: 1,
  borderColor: '#000000',
  borderStyle: 'solid',
};

export const DEFAULT_WATERMARK: Watermark = {
  enabled: false,
  text: 'CONFIDENTIAL',
  fontSize: 72,
  color: '#c0c0c0',
  opacity: 0.35,
  angle: -45,
  image: '',
  imageOpacity: 0.25,
  behind: true,
};

/** @param ownerId group id for group bands, detail report id for drHeader / drDetail / drFooter */
export function newBand(type: BandType, ownerId?: string, height?: number): Band {
  const defaults: Record<BandType, number> = {
    reportHeader: 80,
    pageHeader: 40,
    groupHeader: 32,
    detail: 26,
    groupFooter: 32,
    reportFooter: 50,
    pageFooter: 36,
    drHeader: 26,
    drDetail: 24,
    drFooter: 26,
  };
  const b: Band = {
    id: uid('b'),
    type,
    height: height ?? defaults[type],
    visible: true,
    keepTogether: false,
    pageBreakBefore: false,
    pageBreakAfter: false,
  };
  if (ownerId) {
    if (type === 'drHeader' || type === 'drDetail' || type === 'drFooter') b.detailReportId = ownerId;
    else b.groupId = ownerId;
  }
  if (type === 'drHeader') b.repeatEveryPage = false;
  if (type === 'pageHeader' || type === 'pageFooter') {
    b.printOnFirstPage = true;
    b.printOnLastPage = true;
  }
  if (type === 'groupHeader') b.repeatEveryPage = false;
  return b;
}

export function newReport(): ReportDef {
  const r: ReportDef = {
    version: 1,
    name: 'New Report',
    description: '',
    author: '',
    page: {
      paper: 'A4',
      orientation: 'portrait',
      width: mmToPx(210),
      height: mmToPx(297),
      baseWidth: mmToPx(210),
      autoWidth: false,
      autoHeight: false,
      margins: { top: 48, right: 48, bottom: 48, left: 48 },
    },
    bands: [newBand('reportHeader'), newBand('pageHeader'), newBand('detail'), newBand('reportFooter'), newBand('pageFooter')],
    elements: [],
    groups: [],
    sort: [],
    filter: '',
    dataSourceId: null,
    detailReports: [],
    dataSources: [],
    parameters: [],
    calculatedFields: [],
    styles: [],
    baseStyle: { ...DEFAULT_BASE_STYLE },
    watermark: { ...DEFAULT_WATERMARK },
    locale: 'en-US',
    currency: 'USD',
  };
  return r;
}

export function newCell(text = '', expression = ''): TableCell {
  return { text, expression, format: '', summaryFunc: 'none', style: {} };
}

let nameCounter: Record<string, number> = {};
export function nextName(type: string, existing: ReportElement[]): string {
  const base =
    {
      text: 'label',
      image: 'picture',
      line: 'line',
      shape: 'shape',
      barcode: 'barcode',
      chart: 'chart',
      checkbox: 'checkBox',
      pageInfo: 'pageInfo',
      table: 'table',
      crosstab: 'crossTab',
    }[type] ?? type;
  const used = new Set(existing.map((e) => e.name));
  let n = nameCounter[base] ?? 1;
  while (used.has(base + n)) n++;
  nameCounter[base] = n + 1;
  return base + n;
}

export type ToolId = ElementType | 'field' | 'pageNofM' | 'dateInfo' | 'qr' | 'hline' | 'vline' | 'ellipse';

/** Create a new element of the requested toolbox item. */
export function createElement(tool: ToolId, bandId: string, x: number, y: number, existing: ReportElement[], extra?: Partial<ReportElement>): ReportElement {
  const base = { id: uid('e'), bandId, x, y, style: {} as StyleProps, name: '' };
  let el: ReportElement;
  switch (tool) {
    case 'text':
    case 'field':
      el = {
        ...base,
        type: 'text',
        width: 120,
        height: 22,
        text: tool === 'text' ? 'Label' : '',
        expression: '',
        format: '',
        summaryFunc: 'none',
        summaryRunning: 'none',
        wordWrap: true,
        canGrow: true,
        canShrink: false,
        nullText: '',
      };
      break;
    case 'image':
      el = { ...base, type: 'image', width: 100, height: 80, src: '', expression: '', sizing: 'zoom' };
      break;
    case 'line':
    case 'hline':
      el = { ...base, type: 'line', width: 200, height: 8, direction: 'horizontal', lineWidth: 1, lineStyle: 'solid', lineColor: '#000000' };
      break;
    case 'vline':
      el = { ...base, type: 'line', width: 8, height: 60, direction: 'vertical', lineWidth: 1, lineStyle: 'solid', lineColor: '#000000' };
      break;
    case 'shape':
    case 'ellipse':
      el = {
        ...base,
        type: 'shape',
        width: 100,
        height: 60,
        shape: tool === 'ellipse' ? 'ellipse' : 'rectangle',
        fillColor: '',
        lineColor: '#000000',
        lineWidth: 1,
        lineStyle: 'solid',
        cornerRadius: 8,
      };
      break;
    case 'barcode':
    case 'qr':
      el = {
        ...base,
        type: 'barcode',
        width: tool === 'qr' ? 90 : 200,
        height: tool === 'qr' ? 90 : 60,
        symbology: tool === 'qr' ? 'qr' : 'code128',
        text: '123456789012',
        expression: '',
        showText: tool !== 'qr',
        barColor: '#000000',
      };
      break;
    case 'chart':
      el = {
        ...base,
        type: 'chart',
        width: 360,
        height: 220,
        chartType: 'column',
        title: 'Chart',
        argument: '',
        value: '',
        series: '',
        aggregate: 'sum',
        showLegend: true,
        showLabels: false,
        sortBy: 'none',
        topN: 0,
        palette: '',
        valueFormat: 'n0',
      };
      break;
    case 'checkbox':
      el = { ...base, type: 'checkbox', width: 100, height: 20, expression: '', checked: true, text: 'Check Box' };
      break;
    case 'pageInfo':
    case 'pageNofM':
      el = { ...base, type: 'pageInfo', width: 120, height: 20, info: 'pageNofM', format: 'Page {0} of {1}' };
      break;
    case 'dateInfo':
      el = { ...base, type: 'pageInfo', width: 140, height: 20, info: 'dateTime', format: 'g' };
      break;
    case 'table':
      el = {
        ...base,
        type: 'table',
        width: 300,
        height: 50,
        columns: [100, 100, 100],
        rows: [
          { height: 25, cells: [newCell('Column 1'), newCell('Column 2'), newCell('Column 3')] },
          { height: 25, cells: [newCell(''), newCell(''), newCell('')] },
        ],
        canGrow: true,
        style: { borders: 'tlbr', borderColor: '#9ca3af' },
      };
      break;
    case 'crosstab':
      el = {
        ...base,
        type: 'crosstab',
        width: 330, // = crosstabSize: 120 + 3 × 70, 3 × 22
        height: 66,
        rowField: '',
        columnField: '',
        valueField: '',
        aggregate: 'sum',
        format: 'n0',
        showRowTotals: true,
        showColumnTotals: true,
        rowHeaderWidth: 120,
        cellWidth: 70,
        rowHeight: 22,
        headerBackColor: '#e5e7eb',
        totalBackColor: '#f3f4f6',
        corner: '',
        style: { borders: 'tlbr', borderColor: '#9ca3af', fontSize: 9 },
      };
      break;
    default:
      throw new Error('Unknown tool ' + tool);
  }
  Object.assign(el, extra ?? {});
  el.name = nextName(el.type, existing);
  return el;
}

/** Child detail reports of the main report (parentId null) or of another detail report. */
export function childDetailReports(r: ReportDef, parentId: string | null, mode?: 'once' | 'perRow'): DetailReportDef[] {
  return (r.detailReports ?? []).filter((d) => (d.parentId ?? null) === parentId && (!mode || d.printMode === mode));
}

/** Bands in their visual / processing order. Detail reports follow the band they print after. */
export function orderedBands(r: ReportDef): Band[] {
  const out: Band[] = [];
  const by = (t: BandType) => r.bands.filter((b) => b.type === t);
  const section = (parentId: string | null, mode: 'once' | 'perRow') => {
    for (const d of childDetailReports(r, parentId, mode)) {
      const of = (t: BandType) => r.bands.find((b) => b.type === t && b.detailReportId === d.id);
      const h = of('drHeader');
      const det = of('drDetail');
      const f = of('drFooter');
      if (h) out.push(h);
      if (det) out.push(det);
      section(d.id, 'perRow');
      section(d.id, 'once');
      if (f) out.push(f);
    }
  };
  out.push(...by('reportHeader'), ...by('pageHeader'));
  for (const g of r.groups) {
    const h = r.bands.find((b) => b.type === 'groupHeader' && b.groupId === g.id);
    if (h) out.push(h);
  }
  out.push(...by('detail'));
  section(null, 'perRow');
  for (const g of [...r.groups].reverse()) {
    const f = r.bands.find((b) => b.type === 'groupFooter' && b.groupId === g.id);
    if (f) out.push(f);
  }
  section(null, 'once');
  out.push(...by('reportFooter'), ...by('pageFooter'));
  return out;
}

/** Nesting depth of a detail report (1 = directly under the main report). */
export function detailReportDepth(r: ReportDef, id: string): number {
  let depth = 0;
  let cur = r.detailReports?.find((d) => d.id === id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = cur.parentId ? r.detailReports.find((d) => d.id === cur!.parentId) : undefined;
  }
  return depth;
}

export function bandCaption(r: ReportDef, b: Band): string {
  if (b.type === 'groupHeader' || b.type === 'groupFooter') {
    const gi = r.groups.findIndex((g) => g.id === b.groupId);
    const g = r.groups[gi];
    return `${BAND_LABELS[b.type]} ${gi + 1}${g?.expression ? ' : ' + g.expression : ''}`;
  }
  if (b.type === 'drHeader' || b.type === 'drDetail' || b.type === 'drFooter') {
    const d = r.detailReports?.find((x) => x.id === b.detailReportId);
    if (!d) return BAND_LABELS[b.type];
    const ds = r.dataSources.find((x) => x.id === d.dataSourceId)?.name ?? 'no data source';
    const indent = '› '.repeat(Math.max(0, detailReportDepth(r, d.id) - 1));
    const mode = d.printMode === 'perRow' ? 'per ' + (d.parentId ? 'parent' : 'main') + ' row' : 'once';
    return `${indent}${d.name} · ${BAND_LABELS[b.type]}${b.type === 'drDetail' ? ` — ${ds} (${mode})` : ''}`;
  }
  return BAND_LABELS[b.type];
}

export function contentWidth(r: ReportDef) {
  return r.page.width - r.page.margins.left - r.page.margins.right;
}

/** Merge base -> named style -> inline style -> extra overrides. */
export function resolveStyle(r: ReportDef, styleName: string | undefined, style: StyleProps, ...overrides: (StyleProps | undefined)[]): ResolvedStyle {
  const out: ResolvedStyle = { ...DEFAULT_BASE_STYLE, ...r.baseStyle };
  const assign = (s?: StyleProps) => {
    if (!s) return;
    for (const k of Object.keys(s) as (keyof StyleProps)[]) {
      const v = s[k];
      if (v !== undefined && v !== null) (out as any)[k] = v;
    }
  };
  if (styleName) assign(r.styles.find((s) => s.name === styleName)?.style);
  assign(style);
  for (const o of overrides) assign(o);
  return out;
}

export function cssFont(s: { fontFamily: string; fontSize: number; bold: boolean; italic: boolean }, scale = 1) {
  return `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${(s.fontSize * PT * scale).toFixed(2)}px ${familyList(s.fontFamily)}`;
}

/** Make sure every band referenced by a group exists and stale bands are removed. */
export function normalizeReport(r: ReportDef): ReportDef {
  r.groups ??= [];
  r.detailReports ??= [];
  const drIds = new Set(r.detailReports.map((d) => d.id));
  for (const d of r.detailReports) {
    d.keys ??= [];
    d.sort ??= [];
    d.filter ??= '';
    d.printMode ??= 'once';
    if (d.parentId && (!drIds.has(d.parentId) || d.parentId === d.id)) d.parentId = null;
    if (!r.bands.some((b) => b.type === 'drDetail' && b.detailReportId === d.id)) r.bands.push(newBand('drDetail', d.id));
  }
  // break accidental parent cycles
  for (const d of r.detailReports) {
    const seen = new Set<string>([d.id]);
    let p = d.parentId ? r.detailReports.find((x) => x.id === d.parentId) : undefined;
    while (p) {
      if (seen.has(p.id)) {
        d.parentId = null;
        break;
      }
      seen.add(p.id);
      p = p.parentId ? r.detailReports.find((x) => x.id === p!.parentId) : undefined;
    }
  }
  r.bands = r.bands.filter((b) => !(b.type === 'drHeader' || b.type === 'drDetail' || b.type === 'drFooter') || drIds.has(b.detailReportId!));
  const groupIds = new Set(r.groups.map((g) => g.id));
  r.bands = r.bands.filter((b) => !(b.type === 'groupHeader' || b.type === 'groupFooter') || groupIds.has(b.groupId!));
  for (const g of r.groups) {
    if (!r.bands.some((b) => b.type === 'groupHeader' && b.groupId === g.id)) r.bands.push(newBand('groupHeader', g.id));
  }
  if (!r.bands.some((b) => b.type === 'detail')) r.bands.push(newBand('detail'));
  const bandIds = new Set(r.bands.map((b) => b.id));
  r.elements = r.elements.filter((e) => bandIds.has(e.bandId));
  // a cross tab's box is exactly what the designer draws (older designs could have a bigger, empty box)
  for (const e of r.elements) if (e.type === 'crosstab') syncCrosstabSize(e);
  r.baseStyle = { ...DEFAULT_BASE_STYLE, ...(r.baseStyle ?? {}) };
  r.watermark = { ...DEFAULT_WATERMARK, ...(r.watermark ?? {}) };
  r.styles ??= [];
  r.parameters ??= [];
  r.calculatedFields ??= [];
  r.sort ??= [];
  r.groups ??= [];
  r.dataSources ??= [];
  r.filter ??= '';
  r.locale ??= 'en-US';
  r.currency ??= 'USD';
  r.page.baseWidth ??= r.page.width;
  return r;
}

// ------------------------------------------------------------------ cross tab size
/**
 * What the designer draws for a cross tab: the row header + 2 sample data columns (+ the Total column) wide,
 * the column header + 1 data row (+ the Grand Total row) high. Its box always has exactly this size.
 */
export function crosstabSize(el: CrosstabElement) {
  const cols = 2 + (el.showRowTotals ? 1 : 0);
  const rows = 2 + (el.showColumnTotals ? 1 : 0);
  return { width: Math.round(el.rowHeaderWidth + el.cellWidth * cols), height: Math.round(el.rowHeight * rows), cols, rows };
}
/** box = drawing (after the row header width, cell width, row height or totals changed) */
export function syncCrosstabSize(el: CrosstabElement) {
  el.rowHeaderWidth = Math.max(20, Math.round(el.rowHeaderWidth || 120));
  el.cellWidth = Math.max(20, Math.round(el.cellWidth || 70));
  el.rowHeight = Math.max(12, Math.round(el.rowHeight || 22));
  const s = crosstabSize(el);
  el.width = s.width;
  el.height = s.height;
}
/** Resizing a cross tab with its handles: the row header, the cells and the rows grow / shrink with the box. */
export function scaleCrosstab(el: CrosstabElement, width: number, height: number) {
  const s = crosstabSize(el);
  const kx = width / s.width;
  if (isFinite(kx) && kx > 0 && Math.abs(kx - 1) > 0.001) {
    el.rowHeaderWidth = Math.max(20, Math.round(el.rowHeaderWidth * kx));
    el.cellWidth = Math.max(20, Math.round(el.cellWidth * kx));
  }
  if (isFinite(height) && height > 0 && Math.abs(height - s.height) > 0.5) el.rowHeight = Math.max(12, Math.round(height / s.rows));
  syncCrosstabSize(el);
}

// ------------------------------------------------------------------ page sizing

/** Right-most edge of all controls, in content coordinates (px). */
export function contentRight(r: ReportDef): number {
  return Math.max(0, ...r.elements.map((e) => e.x + e.width));
}

/** Select a paper size (keeps orientation; roll paper switches on auto height). */
export function applyPaper(p: PageSettings, paper: string) {
  const s = PAPER_SIZES[paper];
  if (!s) {
    p.paper = 'Custom';
    return;
  }
  p.paper = paper;
  let w = mmToPx(s.w);
  let h = mmToPx(s.h);
  if (s.roll) {
    p.orientation = 'portrait';
    p.autoHeight = true;
    const m = mmToPx(3);
    p.margins = { top: m, right: m, bottom: m, left: m };
  } else if (p.orientation === 'landscape') [w, h] = [h, w];
  p.baseWidth = w;
  p.width = w;
  p.height = h;
}

export function applyOrientation(p: PageSettings, o: 'portrait' | 'landscape') {
  if (p.orientation === o) return;
  p.orientation = o;
  const bw = p.baseWidth ?? p.width;
  p.baseWidth = p.height;
  p.width = p.height;
  p.height = bw;
}

export function setCustomPageSize(p: PageSettings, w: number, h: number) {
  p.paper = 'Custom';
  p.baseWidth = Math.max(mmToPx(10), w);
  p.width = p.baseWidth;
  p.height = Math.max(mmToPx(10), h);
}

/** With autoWidth the page grows to fit the widest control (and shrinks back down to the chosen paper width). */
export function applyAutoWidth(r: ReportDef) {
  const p = r.page;
  const base = p.baseWidth ?? p.width;
  let w = base;
  if (p.autoWidth) w = Math.max(base, Math.ceil(contentRight(r) + p.margins.left + p.margins.right));
  if (Math.abs(w - p.width) > 0.01) p.width = w;
}

export function marginPreset(p: PageSettings): string {
  const vals = [p.margins.top, p.margins.right, p.margins.bottom, p.margins.left];
  for (const [k, v] of Object.entries(MARGIN_PRESETS)) if (vals.every((x) => Math.abs(x - mmToPx(v.mm)) < 0.5)) return k;
  return 'custom';
}

export function pageSizeText(p: PageSettings): string {
  const r1 = (v: number) => Math.round(pxToMm(v) * 10) / 10;
  const name = p.paper === 'Custom' ? 'Custom' : (PAPER_SIZES[p.paper]?.label.split(' (')[0] ?? p.paper);
  return `${name} · ${r1(p.width)} × ${p.autoHeight ? 'auto' : r1(p.height)} mm`;
}
