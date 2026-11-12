import { deepClone } from '../model/clone';
// Central designer state (Vue reactivity) + editing commands with undo/redo.
import { computed, markRaw, reactive, shallowReactive, toRaw, watch } from 'vue';
import type { Band, BandType, DataSourceDef, DetailReportDef, FieldDef, HAlign, ReportDef, ReportElement, Row, StyleProps, SummaryFunc, TableCell, TableElement, TextElement } from '../model/types';
import { textWidth } from '../engine/measure';
import {
  applyAutoWidth,
  applyOrientation,
  applyPaper,
  contentRight,
  contentWidth,
  createElement,
  MARGIN_PRESETS,
  mmToPx,
  newBand,
  newReport,
  normalizeReport,
  orderedBands,
  resolveStyle,
  setCustomPageSize,
  uid,
  type ToolId,
} from '../model/defaults';
import { inferFields, loadDataSource, loadDataSourceSync } from '../data/dataSource';
import { DbError, listConnections, resolveSqlParams } from '../data/dbApi';
import { compileCalcFields, paramValues, renderReport } from '../engine/renderer';
import {
  cellOwners,
  cellsIn,
  emptyCell,
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  mergeRange,
  normalizeSpans,
  ownerOf,
  rangeOf,
  spanOf,
  unmergeRange,
  type CellPos,
  type CellRange,
} from '../model/table';
import { evalExpr, type EvalContext } from '../engine/expression';
import { ensureReportFonts } from '../engine/fonts';

export type DialogType =
  | 'expression'
  | 'dataSources'
  | 'groupSort'
  | 'parameters'
  | 'calcFields'
  | 'pageSetup'
  | 'styles'
  | 'formatRules'
  | 'watermark'
  | 'wizard'
  | 'detailReports'
  | 'saveInfo'
  | 'about';

export interface ExprRequest {
  value: string;
  title: string;
  resolve: (v: string | null) => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

const AUTOSAVE_KEY = 'reporttool.autosave.v2';
const PREVIOUS_KEY = 'reporttool.previous.v2';

export const state = reactive({
  report: newReport() as ReportDef,
  selection: [] as string[],
  selectedBandId: null as string | null,
  /** selected table cell; row2 / col2 = other corner of a cell range (Shift+click or drag across cells) */
  selectedCell: null as { id: string; row: number; col: number; row2?: number; col2?: number } | null,
  zoom: 1,
  showGrid: true,
  snapToGrid: true,
  snapLines: true,
  gridSize: 8,
  rulerUnit: 'cm' as 'cm' | 'in' | 'px',
  mode: 'design' as 'design' | 'preview',
  dialog: null as DialogType | null,
  dialogProps: null as any,
  exprRequest: null as ExprRequest | null,
  loginRequests: [] as LoginRequest[],
  formatBrush: null as FormatBrush | null,
  fileName: 'report.rptx',
  dirty: false,
  tool: null as ToolId | null,
  paramValues: {} as Record<string, unknown>,
  revision: 0,
  toasts: [] as Toast[],
  leftTab: 'toolbox' as 'toolbox' | 'fields',
  rightTab: 'properties' as 'properties' | 'explorer',
  /** running inside another system (iframe): the host stores the reports, no local files / autosave */
  embedded: false,
});

/** Loaded rows per data source id (kept non-deep-reactive for speed). */
export const dataCache = shallowReactive<Record<string, Row[]>>({});
export const dataErrors = reactive<Record<string, string>>({});

// ------------------------------------------------------------------ notifications
let toastId = 1;
export function notify(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: toastId++, text, kind };
  state.toasts.push(t);
  setTimeout(() => {
    const i = state.toasts.findIndex((x) => x.id === t.id);
    if (i >= 0) state.toasts.splice(i, 1);
  }, kind === 'error' ? 6000 : 3000);
}

// ------------------------------------------------------------------ history
const undoStack: ReportDef[] = [];
const redoStack: ReportDef[] = [];
let lastMerge = '';
let lastMergeTime = 0;
export const history = reactive({ canUndo: false, canRedo: false });

const snapshot = (): ReportDef => deepClone((state.report)) as ReportDef;
function syncHistoryFlags() {
  history.canUndo = undoStack.length > 0;
  history.canRedo = redoStack.length > 0;
}

/** Apply a change to the report. Consecutive changes with the same mergeKey within 1.5s form one undo step. */
export function mutate(fn: (r: ReportDef) => void, mergeKey?: string) {
  const now = Date.now();
  const merge = !!mergeKey && mergeKey === lastMerge && now - lastMergeTime < 1500;
  if (!merge) {
    undoStack.push(snapshot());
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
  }
  lastMerge = mergeKey ?? '';
  lastMergeTime = now;
  fn(state.report);
  applyAutoWidth(state.report);
  state.dirty = true;
  state.revision++;
  syncHistoryFlags();
}

/**
 * Changes made continuously while dragging (e.g. a table column border): the first call of a drag takes the
 * undo snapshot, later calls with the same key just update the report — the whole drag is one undo step.
 */
let liveKey = '';
export function mutateLive(key: string, fn: (r: ReportDef) => void) {
  if (key !== liveKey) {
    liveKey = key;
    mutate(fn);
    lastMerge = '';
    return;
  }
  fn(state.report);
  applyAutoWidth(state.report);
  state.dirty = true;
  state.revision++;
}
export function endLive() {
  liveKey = '';
}

function restore(r: ReportDef) {
  state.report = r;
  const ids = new Set(r.elements.map((e) => e.id));
  state.selection = state.selection.filter((id) => ids.has(id));
  if (state.selectedBandId && !r.bands.some((b) => b.id === state.selectedBandId)) state.selectedBandId = null;
  state.selectedCell = null;
  state.revision++;
  state.dirty = true;
  lastMerge = '';
}
export function undo() {
  const r = undoStack.pop();
  if (!r) return;
  redoStack.push(snapshot());
  restore(r);
  syncHistoryFlags();
}
export function redo() {
  const r = redoStack.pop();
  if (!r) return;
  undoStack.push(snapshot());
  restore(r);
  syncHistoryFlags();
}

// ------------------------------------------------------------------ selection
export const selectedElements = computed(() => {
  const set = new Set(state.selection);
  return state.report.elements.filter((e) => set.has(e.id));
});
export const primaryElement = computed<ReportElement | null>(() => {
  const id = state.selection[state.selection.length - 1];
  return state.report.elements.find((e) => e.id === id) ?? null;
});
export const selectedBand = computed<Band | null>(() => state.report.bands.find((b) => b.id === state.selectedBandId) ?? null);

export function select(ids: string[], additive = false) {
  state.selectedCell = null;
  if (additive) {
    const s = new Set(state.selection);
    for (const id of ids) {
      if (s.has(id)) s.delete(id);
      else s.add(id);
    }
    state.selection = [...s];
  } else state.selection = [...ids];
  if (state.selection.length) state.selectedBandId = null;
}
export function selectBand(id: string | null) {
  state.selection = [];
  state.selectedCell = null;
  state.selectedBandId = id;
}
export function selectAll() {
  const bandId = primaryElement.value?.bandId ?? state.selectedBandId;
  state.selection = state.report.elements.filter((e) => !bandId || e.bandId === bandId).map((e) => e.id);
}
export function clearSelection() {
  state.selection = [];
  state.selectedCell = null;
  state.selectedBandId = null;
}

// ------------------------------------------------------------------ element commands
export function findElement(id: string) {
  return state.report.elements.find((e) => e.id === id);
}
export function findBand(id: string) {
  return state.report.bands.find((b) => b.id === id);
}

export function ensureBandFits(r: ReportDef, bandId: string) {
  const band = r.bands.find((b) => b.id === bandId);
  if (!band) return;
  const bottom = Math.max(0, ...r.elements.filter((e) => e.bandId === bandId).map((e) => e.y + e.height));
  if (bottom > band.height) band.height = Math.ceil(bottom);
}

export function addElement(tool: ToolId, bandId: string, x: number, y: number, extra?: Partial<ReportElement>): ReportElement {
  let el!: ReportElement;
  mutate((r) => {
    el = createElement(tool, bandId, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)), r.elements, extra);
    const cw = contentWidth(r);
    if (!r.page.autoWidth && el.x + el.width > cw) el.x = Math.max(0, cw - el.width);
    r.elements.push(el);
    ensureBandFits(r, bandId);
  });
  state.selection = [el.id];
  state.selectedBandId = null;
  return el;
}

export function deleteSelection() {
  if (!state.selection.length) {
    if (state.selectedBandId) removeBand(state.selectedBandId);
    return;
  }
  const ids = new Set(state.selection);
  mutate((r) => {
    r.elements = r.elements.filter((e) => !ids.has(e.id) || e.locked);
  });
  state.selection = [];
  state.selectedCell = null;
}

// ------------------------------------------------------------------ clipboard
/** Clipboard content. It is also written to the system clipboard as JSON text, so it can be pasted into another report / tab. */
export type ClipPayload = { kind: 'elements'; elements: ReportElement[]; bandTypes: Record<string, BandType> } | { kind: 'cells'; cells: TableCell[][] };
export interface PasteTarget {
  bandId?: string;
  /** band-relative position (px) of the pasted content's top-left corner */
  at?: { x: number; y: number };
}
const CLIP_TAG = 'reportToolClipboard';
let clip: ClipPayload | null = null;
let pasteCount = 0;

export const clipboardText = (p: ClipPayload) => JSON.stringify({ [CLIP_TAG]: 1, ...p });
export function parseClipboardText(text: string): ClipPayload | null {
  if (!text || !text.trimStart().startsWith('{') || !text.includes(CLIP_TAG)) return null;
  try {
    const o = JSON.parse(text);
    if (o?.[CLIP_TAG] && o.kind === 'elements' && Array.isArray(o.elements)) return { kind: 'elements', elements: o.elements, bandTypes: o.bandTypes ?? {} };
    if (o?.[CLIP_TAG] && o.kind === 'cells' && Array.isArray(o.cells)) return { kind: 'cells', cells: o.cells };
  } catch {
    /* not ours */
  }
  return null;
}
export const hasClipboard = () => !!clip;
export function writeSystemClipboard(p: ClipPayload) {
  try {
    navigator.clipboard?.writeText(clipboardText(p)).catch(() => {});
  } catch {
    /* clipboard API unavailable */
  }
}

/** Copy the selected controls — or the selected table cell — into the clipboard. */
export function copySelection(silent = false): ClipPayload | null {
  const cell = state.selectedCell;
  const el = primaryElement.value;
  let p: ClipPayload | null = null;
  if (cell && el?.type === 'table' && el.id === cell.id && state.selection.length === 1) {
    // the selected cell or cell range (merged cells keep their span inside the range)
    const rg = rangeOf(el, { row: cell.row, col: cell.col }, { row: cell.row2 ?? cell.row, col: cell.col2 ?? cell.col });
    const owners = cellOwners(el);
    const grid: TableCell[][] = [];
    for (let r = rg.r0; r <= rg.r1; r++) {
      const line: TableCell[] = [];
      for (let c = rg.c0; c <= rg.c1; c++) {
        const o = owners[r][c];
        const src = el.rows[r].cells[c];
        line.push(o.row === r && o.col === c && src ? deepClone(src) : { ...emptyCell(), style: deepClone(el.rows[o.row].cells[o.col].style ?? {}) });
      }
      grid.push(line);
    }
    if (grid.length) p = { kind: 'cells', cells: grid };
  } else if (selectedElements.value.length) {
    const elements = deepClone(selectedElements.value) as ReportElement[];
    const bandTypes: Record<string, BandType> = {};
    for (const e of elements) bandTypes[e.bandId] = findBand(e.bandId)?.type ?? 'detail';
    p = { kind: 'elements', elements, bandTypes };
  }
  if (!p) return null;
  clip = p;
  pasteCount = 0;
  const nCells = p.kind === 'cells' ? p.cells.reduce((a, row) => a + row.length, 0) : 0;
  if (!silent) notify(p.kind === 'cells' ? (nCells > 1 ? `Copied ${nCells} table cells` : 'Copied the table cell') : `Copied ${p.elements.length} control(s)`);
  return p;
}
export function cutSelection(): ClipPayload | null {
  const p = copySelection(true);
  if (!p) return null;
  if (p.kind === 'cells') {
    const cell = state.selectedCell!;
    mutate((r) => {
      const t = r.elements.find((e) => e.id === cell.id);
      if (t?.type !== 'table') return;
      for (const pos of selectedCellsOf(t)) {
        const c = t.rows[pos.row]?.cells[pos.col];
        if (c) Object.assign(c, { text: '', expression: '', summaryFunc: 'none' });
      }
    });
  } else deleteSelection();
  notify(p.kind === 'cells' ? 'Cut the table cell(s)' : `Cut ${p.elements.length} control(s)`);
  return p;
}

/** Paste the designer clipboard (button / context menu / Ctrl+V fallback). */
export function pasteClipboard(targetBandId?: string, at?: { x: number; y: number }) {
  if (!clip) {
    notify('The clipboard is empty — copy a control first (Ctrl+C)');
    return;
  }
  pastePayload(clip, { bandId: targetBandId, at });
}

/** Band chosen by the user for a paste: explicit target, band of the selected control, or the selected band. */
function chosenBandId(target: PasteTarget): string | null {
  const r = state.report;
  for (const id of [target.bandId, primaryElement.value?.bandId, state.selectedBandId]) if (id && r.bands.some((b) => b.id === id)) return id;
  return null;
}
function targetBandId(target: PasteTarget): string {
  const r = state.report;
  return chosenBandId(target) ?? r.bands.find((b) => b.type === 'detail')?.id ?? r.bands[0].id;
}
const uniqueName = (r: ReportDef, name: string) => {
  const taken = new Set(r.elements.map((e) => e.name));
  const base = name.replace(/\d+$/, '') || 'control';
  let n = 1;
  while (taken.has(base + n)) n++;
  return base + n;
};

export function pastePayload(p: ClipPayload, target: PasteTarget = {}) {
  if (p.kind === 'cells') return pasteCells(p.cells, false, target);
  const r = state.report;
  const els = p.elements;
  if (!els.length) return;
  const srcBands = [...new Set(els.map((e) => e.bandId))];
  const explicit = target.bandId && r.bands.some((b) => b.id === target.bandId) ? target.bandId : null;
  // nothing chosen: each control goes back to its own band, or to the same kind of band in another report
  const dest = explicit ?? (srcBands.length === 1 ? chosenBandId(target) : null);
  const mapBand = (srcId: string) => {
    if (dest) return dest;
    if (r.bands.some((b) => b.id === srcId)) return srcId;
    const t = p.bandTypes[srcId];
    return r.bands.find((b) => b.type === t)?.id ?? targetBandId({});
  };
  let dx = 0;
  let dy = 0;
  if (target.at) {
    dx = target.at.x - Math.min(...els.map((e) => e.x));
    dy = target.at.y - Math.min(...els.map((e) => e.y));
  } else {
    pasteCount++;
    // cascade copies that land in their own band so they don't sit exactly on top of the original
    const sameBand = els.every((e) => mapBand(e.bandId) === e.bandId && r.elements.some((x) => x.bandId === e.bandId));
    dx = dy = sameBand ? 10 * pasteCount : 0;
  }
  const ids: string[] = [];
  mutate((rr) => {
    const cw = contentWidth(rr);
    for (const src of els) {
      const el = deepClone(src) as ReportElement;
      el.id = uid('e');
      el.bandId = mapBand(src.bandId);
      el.name = uniqueName(rr, el.name);
      el.x = Math.max(0, Math.round(el.x + dx));
      el.y = Math.max(0, Math.round(el.y + dy));
      if (!rr.page.autoWidth && el.width <= cw && el.x + el.width > cw) el.x = Math.max(0, Math.floor(cw - el.width));
      el.locked = false;
      rr.elements.push(el);
      ids.push(el.id);
      ensureBandFits(rr, el.bandId);
    }
  });
  state.selection = ids;
  state.selectedCell = null;
  state.selectedBandId = null;
}

/**
 * Paste a grid of cells. Into a selected table cell: fills the cells to the right / below (adds rows when needed),
 * like a spreadsheet. With `textOnly` only the text is replaced (cell formatting is kept). Otherwise creates a table.
 */
export function pasteCells(cells: TableCell[][], textOnly: boolean, target: PasteTarget = {}) {
  const sel = state.selectedCell;
  const el = sel ? findElement(sel.id) : null;
  if (sel && el?.type === 'table') {
    mutate((r) => {
      const t = r.elements.find((e) => e.id === sel.id) as TableElement;
      cells.forEach((row, ri) => {
        const rIdx = sel.row + ri;
        while (t.rows.length <= rIdx) {
          const last = t.rows[t.rows.length - 1];
          t.rows.push({ height: last.height, cells: last.cells.map((c) => ({ ...deepClone(c), text: '', expression: '', summaryFunc: 'none' as const })) });
        }
        row.forEach((c, ci) => {
          const cIdx = sel.col + ci;
          const dst = t.rows[rIdx].cells[cIdx];
          if (!dst) return;
          if (textOnly) Object.assign(dst, { text: c.text, expression: '', summaryFunc: 'none' });
          else {
            delete dst.colSpan;
            delete dst.rowSpan;
            Object.assign(dst, deepClone(c));
          }
        });
      });
      normalizeSpans(t);
      t.height = t.rows.reduce((a, b) => a + b.height, 0);
      ensureBandFits(r, t.bandId);
    });
    return;
  }
  // no cell selected: make a new table from the grid
  const cols = Math.max(...cells.map((r) => r.length));
  const cw = contentWidth(state.report);
  const colW = Math.max(40, Math.min(150, Math.floor(cw / cols)));
  const at = target.at ?? { x: 0, y: 0 };
  const grid = {
    columns: Array.from({ length: cols }, () => colW),
    rows: cells.map((row) => ({ height: 22, cells: Array.from({ length: cols }, (_, i) => deepClone(row[i] ?? emptyCell())) })),
  } as TableElement;
  normalizeSpans(grid);
  addElement('table', targetBandId(target), at.x, at.y, { ...grid, width: colW * cols, height: 22 * cells.length } as Partial<ReportElement>);
}

/** Text from another application: Excel cells -> table (or into the selected cells), [Field] -> data field, other text -> label. */
export function pasteText(raw: string, target: PasteTarget = {}) {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!text.trim()) return;
  const grid = text.split('\n').map((l) => l.split('\t'));
  const isGrid = grid.some((r) => r.length > 1);
  const asCells = grid.map((r) => r.map((t) => ({ text: t, expression: '', format: '', summaryFunc: 'none' as const, style: {} })));
  if (state.selectedCell) return pasteCells(asCells, true, target);
  if (isGrid) return pasteCells(asCells, false, target);
  const at = target.at ?? { x: 0, y: 0 };
  const lines = grid.length;
  const single = text.trim();
  const st = resolveStyle(state.report, undefined, {});
  const longest = Math.max(...grid.map((r) => textWidth(r[0], { family: st.fontFamily, size: st.fontSize, bold: st.bold, italic: st.italic })));
  const width = Math.min(contentWidth(state.report) - at.x, Math.max(60, Math.ceil(longest) + 2 * st.padding + 4));
  const field = /^\[[^\]\n]+\]$/.test(single) || /^\?\w+$/.test(single);
  addElement(field ? 'field' : 'text', targetBandId(target), at.x, at.y, {
    text: field ? '' : text,
    expression: field ? single : '',
    width: Math.max(40, width),
    height: Math.max(22, Math.ceil(lines * st.fontSize * 1.5 + 2 * st.padding)),
  } as Partial<ReportElement>);
}

/** An image from the clipboard (screenshot, copied picture) -> picture control. */
export async function pasteImage(file: Blob, target: PasteTarget = {}) {
  const url = await new Promise<string>((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result));
    rd.onerror = () => reject(rd.error);
    rd.readAsDataURL(file);
  });
  const size = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 100, h: img.naturalHeight || 80 });
    img.onerror = () => resolve({ w: 100, h: 80 });
    img.src = url;
  });
  const at = target.at ?? { x: 0, y: 0 };
  const maxW = Math.min(400, contentWidth(state.report) - at.x);
  const width = Math.max(16, Math.min(size.w, maxW));
  const height = Math.max(16, Math.round((size.h * width) / size.w));
  addElement('image', targetBandId(target), at.x, at.y, { src: url, width, height, sizing: 'zoom' } as Partial<ReportElement>);
  notify('Pasted image as a picture control');
}

/** Paste from the system clipboard (ribbon / context menu, where no paste event is available). */
export async function pasteFromSystem(target: PasteTarget = {}) {
  try {
    const items = await (navigator.clipboard as any)?.read?.();
    if (items) {
      for (const it of items) {
        const img = it.types.find((t: string) => t.startsWith('image/'));
        if (img) return void (await pasteImage(await it.getType(img), target));
      }
      for (const it of items) {
        if (it.types.includes('text/plain')) {
          const text = await (await it.getType('text/plain')).text();
          const p = parseClipboardText(text);
          if (p) return pastePayload(p, target);
          if (!clip && text) return pasteText(text, target);
        }
      }
    }
  } catch {
    /* permission refused or API missing: use the designer clipboard */
  }
  if (clip) pastePayload(clip, target);
  else notify('Nothing to paste — copy a control, text or picture first');
}

export function duplicateSelection() {
  const els = deepClone(selectedElements.value) as ReportElement[];
  if (!els.length) return;
  pasteCount = 0;
  pastePayload({ kind: 'elements', elements: els, bandTypes: {} });
}

// ------------------------------------------------------------------ format painter
export interface FormatBrush {
  style: StyleProps;
  styleName?: string;
  shape?: Record<string, unknown>;
}
/** Copy the formatting of the selected control / cell; the next click on a control applies it. */
export function startFormatPainter() {
  const el = primaryElement.value;
  if (!el) return notify('Select a control to copy its formatting');
  const cell = state.selectedCell && state.selectedCell.id === el.id && el.type === 'table' ? el.rows[state.selectedCell.row]?.cells[state.selectedCell.col] : null;
  const shape: Record<string, unknown> = {};
  for (const k of ['lineColor', 'lineWidth', 'lineStyle', 'fillColor', 'cornerRadius', 'barColor']) if (k in el) shape[k] = (el as any)[k];
  state.formatBrush = { style: deepClone(cell ? cell.style : el.style), styleName: cell ? undefined : el.styleName, shape };
  notify('Format Painter: click a control or table cell to apply the formatting (Esc to cancel)');
}
export function applyFormatBrush(elementId: string, cell: { row: number; col: number } | null) {
  const b = state.formatBrush;
  if (!b) return;
  mutate((r) => {
    const el = r.elements.find((e) => e.id === elementId);
    if (!el) return;
    if (cell && el.type === 'table') {
      const c = el.rows[cell.row]?.cells[cell.col];
      if (c) c.style = deepClone(b.style);
      return;
    }
    el.style = deepClone(b.style);
    if (b.styleName !== undefined || el.styleName) el.styleName = b.styleName;
    for (const [k, v] of Object.entries(b.shape ?? {})) if (k in el) (el as any)[k] = v;
  });
  state.formatBrush = null;
}

export function moveElements(moves: { id: string; x: number; y: number; bandId: string }[]) {
  mutate((r) => {
    const touched = new Set<string>();
    for (const m of moves) {
      const el = r.elements.find((e) => e.id === m.id);
      if (!el || el.locked) continue;
      el.x = Math.round(m.x);
      el.y = Math.max(0, Math.round(m.y));
      el.bandId = m.bandId;
      touched.add(m.bandId);
    }
    touched.forEach((b) => ensureBandFits(r, b));
  });
}

export function resizeElements(rects: { id: string; x: number; y: number; width: number; height: number }[]) {
  mutate((r) => {
    for (const rc of rects) {
      const el = r.elements.find((e) => e.id === rc.id);
      if (!el || el.locked) continue;
      const sx = rc.width / el.width;
      const sy = rc.height / el.height;
      el.x = Math.round(rc.x);
      el.y = Math.max(0, Math.round(rc.y));
      el.width = Math.max(2, Math.round(rc.width));
      el.height = Math.max(2, Math.round(rc.height));
      if (el.type === 'table') scaleTable(el, sx, sy);
      ensureBandFits(r, el.bandId);
    }
  });
}

export function scaleTable(el: TableElement, sx: number, sy: number) {
  if (isFinite(sx) && Math.abs(sx - 1) > 0.001) {
    el.columns = el.columns.map((c) => Math.max(8, Math.round(c * sx)));
    el.width = el.columns.reduce((a, b) => a + b, 0);
  }
  if (isFinite(sy) && Math.abs(sy - 1) > 0.001) {
    el.rows.forEach((row) => (row.height = Math.max(8, Math.round(row.height * sy))));
    el.height = el.rows.reduce((a, b) => a + b.height, 0);
  }
}

export function nudge(dx: number, dy: number, resize = false) {
  if (!state.selection.length) return;
  const ids = new Set(state.selection);
  mutate((r) => {
    for (const el of r.elements) {
      if (!ids.has(el.id) || el.locked) continue;
      if (resize) {
        el.width = Math.max(2, el.width + dx);
        el.height = Math.max(2, el.height + dy);
        if (el.type === 'table') {
          el.columns[el.columns.length - 1] = Math.max(8, el.columns[el.columns.length - 1] + dx);
          el.rows[el.rows.length - 1].height = Math.max(8, el.rows[el.rows.length - 1].height + dy);
          el.width = el.columns.reduce((a, b) => a + b, 0);
          el.height = el.rows.reduce((a, b) => a + b.height, 0);
        }
      } else {
        el.x += dx;
        el.y = Math.max(0, el.y + dy);
      }
      ensureBandFits(r, el.bandId);
    }
  }, 'nudge');
}

function getPath(o: any, path: string) {
  return path.split('.').reduce((c, p) => (c == null ? c : c[p]), o);
}
function setPath(o: any, path: string, v: unknown) {
  const parts = path.split('.');
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (v === undefined) delete cur[last];
  else cur[last] = v;
}
export { getPath, setPath };

/** Set a property (dotted path) on every selected element (or the selected table cell). */
export function setElementProp(path: string, value: unknown, ids?: string[]) {
  const cell = state.selectedCell;
  const targets = new Set(ids ?? state.selection);
  mutate((r) => {
    for (const el of r.elements) {
      if (!targets.has(el.id)) continue;
      if (cell && cell.id === el.id && el.type === 'table' && !ids) {
        // the selected cell — or every cell of a selected range
        for (const p of selectedCellsOf(el)) {
          const c = el.rows[p.row]?.cells[p.col];
          if (c) setPath(c, path, value);
        }
        continue;
      }
      setPath(el, path, value);
      if (path === 'width' || path === 'height') {
        if (el.type === 'table') {
          const tw = el.columns.reduce((a, b) => a + b, 0);
          const th = el.rows.reduce((a, b) => a + b.height, 0);
          scaleTable(el, el.width / tw, el.height / th);
        }
        ensureBandFits(r, el.bandId);
      }
      if (path === 'y') ensureBandFits(r, el.bandId);
    }
  }, 'prop:' + path + ':' + [...targets].join(','));
}

export function setBandProp(bandId: string, path: string, value: unknown) {
  mutate((r) => {
    const b = r.bands.find((x) => x.id === bandId);
    if (b) setPath(b, path, value);
    if (b && path === 'height') {
      const minH = Math.max(0, ...r.elements.filter((e) => e.bandId === bandId).map((e) => e.y + e.height));
      if (b.height < minH) b.height = Math.ceil(minH);
    }
  }, 'band:' + bandId + ':' + path);
}

export function setReportProp(path: string, value: unknown) {
  mutate((r) => setPath(r, path, value), 'report:' + path);
}

export function zOrder(front: boolean) {
  const ids = new Set(state.selection);
  mutate((r) => {
    const sel = r.elements.filter((e) => ids.has(e.id));
    const rest = r.elements.filter((e) => !ids.has(e.id));
    r.elements = front ? [...rest, ...sel] : [...sel, ...rest];
  });
}

export type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export function alignSelection(kind: AlignKind) {
  const els = selectedElements.value;
  const ref = primaryElement.value;
  if (els.length < 2 || !ref) return;
  mutate((r) => {
    for (const s of els) {
      const el = r.elements.find((e) => e.id === s.id)!;
      if (el.id === ref.id || el.locked) continue;
      if (kind === 'left') el.x = ref.x;
      if (kind === 'right') el.x = ref.x + ref.width - el.width;
      if (kind === 'center') el.x = Math.round(ref.x + ref.width / 2 - el.width / 2);
      if (kind === 'top') el.y = ref.y;
      if (kind === 'bottom') el.y = Math.max(0, ref.y + ref.height - el.height);
      if (kind === 'middle') el.y = Math.max(0, Math.round(ref.y + ref.height / 2 - el.height / 2));
      ensureBandFits(r, el.bandId);
    }
  });
}
export function sameSize(kind: 'width' | 'height' | 'both') {
  const els = selectedElements.value;
  const ref = primaryElement.value;
  if (els.length < 2 || !ref) return;
  mutate((r) => {
    for (const s of els) {
      const el = r.elements.find((e) => e.id === s.id)!;
      if (el.id === ref.id || el.locked || el.type === 'table') continue;
      if (kind !== 'height') el.width = ref.width;
      if (kind !== 'width') el.height = ref.height;
      ensureBandFits(r, el.bandId);
    }
  });
}
export function distribute(dir: 'h' | 'v') {
  const els = [...selectedElements.value].sort((a, b) => (dir === 'h' ? a.x - b.x : a.y - b.y));
  if (els.length < 3) return;
  const first = els[0];
  const last = els[els.length - 1];
  const total = dir === 'h' ? last.x + last.width - first.x : last.y + last.height - first.y;
  const sizes = els.reduce((s, e) => s + (dir === 'h' ? e.width : e.height), 0);
  const gap = (total - sizes) / (els.length - 1);
  mutate((r) => {
    let pos = dir === 'h' ? first.x : first.y;
    for (const s of els) {
      const el = r.elements.find((e) => e.id === s.id)!;
      if (dir === 'h') {
        el.x = Math.round(pos);
        pos += el.width + gap;
      } else {
        el.y = Math.round(pos);
        pos += el.height + gap;
      }
    }
  });
}
export function alignToGrid() {
  const g = state.gridSize;
  const ids = new Set(state.selection);
  mutate((r) => {
    for (const el of r.elements)
      if (ids.has(el.id)) {
        el.x = Math.round(el.x / g) * g;
        el.y = Math.round(el.y / g) * g;
      }
  });
}
/** Fit the band height to its content. */
export function fitBandToContent(bandId: string) {
  mutate((r) => {
    const b = r.bands.find((x) => x.id === bandId);
    if (!b) return;
    const bottom = Math.max(0, ...r.elements.filter((e) => e.bandId === bandId).map((e) => e.y + e.height));
    b.height = Math.max(4, Math.ceil(bottom));
  });
}

// ------------------------------------------------------------------ field binding
export interface FieldChoice {
  expr: string; // [Field], [Calc] or ?Param
  name: string;
  type: string; // string | number | date | boolean | calc | special
  /** special fields: static text with {expressions} instead of an expression (e.g. "Page {PageNumber()} of {PageCount()}") */
  text?: string;
  format?: string;
  align?: HAlign;
  /** caption for an empty header cell above (e.g. "No.") */
  caption?: string;
}
/** Bind a label or a table cell to a field (sets the expression, clears static text, sensible alignment/format). */
export function bindToField(elementId: string, cell: { row: number; col: number } | null, f: FieldChoice) {
  mutate((r) => {
    const el = r.elements.find((e) => e.id === elementId);
    if (!el) return;
    const apply = (o: { text: string; expression: string; format: string; summaryFunc?: string; style: Record<string, unknown> }) => {
      if (f.text !== undefined) {
        o.text = f.text;
        o.expression = '';
      } else {
        o.expression = f.expr;
        o.text = '';
      }
      if (f.type === 'special') o.summaryFunc = 'none';
      if (f.align && o.style.textAlign === undefined) o.style.textAlign = f.align;
      else if (f.type === 'number' && o.style.textAlign === undefined) o.style.textAlign = 'right';
      if (f.format && !o.format) o.format = f.format;
      if (f.type === 'date' && !o.format) o.format = 'd';
    };
    if (cell && el.type === 'table') {
      const c = el.rows[cell.row]?.cells[cell.col];
      if (!c) return;
      apply(c as any);
      // the header cell above still has a placeholder -> use the field name
      const ab = cell.row > 0 ? ownerOf(el, cell.row - 1, cell.col) : null;
      const above = ab ? el.rows[ab.row].cells[ab.col] : null;
      if (above && !above.expression && (/^Column \d+$/.test(above.text.trim()) || !above.text.trim())) {
        above.text = f.caption ?? f.name;
        if (f.type === 'number' && above.style.textAlign === undefined) above.style.textAlign = 'right';
      }
    } else if (el.type === 'text') apply(el as any);
  });
}
export function clearBinding(elementId: string, cell: { row: number; col: number } | null) {
  mutate((r) => {
    const el = r.elements.find((e) => e.id === elementId);
    if (!el) return;
    if (cell && el.type === 'table') {
      const c = el.rows[cell.row]?.cells[cell.col];
      if (c) c.expression = '';
    } else if (el.type === 'text') el.expression = '';
  });
}

// ------------------------------------------------------------------ detail reports (sub-sections)
export function addDetailReport(opts: Partial<DetailReportDef> & { header?: boolean; footer?: boolean } = {}): string {
  let id = '';
  mutate((r) => {
    r.detailReports ??= [];
    id = uid('dr');
    let n = r.detailReports.length + 1;
    while (r.detailReports.some((d) => d.name === 'Detail Report ' + n)) n++;
    const d: DetailReportDef = {
      id,
      name: opts.name || 'Detail Report ' + n,
      dataSourceId: opts.dataSourceId ?? r.dataSources.find((x) => x.id !== r.dataSourceId)?.id ?? r.dataSources[0]?.id ?? null,
      parentId: opts.parentId ?? null,
      printMode: opts.printMode ?? 'once',
      keys: opts.keys ?? [],
      filter: opts.filter ?? '',
      sort: opts.sort ?? [],
    };
    r.detailReports.push(d);
    if (opts.header !== false) r.bands.push(newBand('drHeader', id));
    r.bands.push(newBand('drDetail', id));
    if (opts.footer) r.bands.push(newBand('drFooter', id));
  });
  return id;
}

export function updateDetailReport(id: string, patch: Partial<DetailReportDef>, mergeKey?: string) {
  mutate((r) => {
    const d = r.detailReports.find((x) => x.id === id);
    if (d) Object.assign(d, patch);
  }, mergeKey ?? 'dr:' + id + ':' + Object.keys(patch).join());
}

/** Remove a detail report, its nested detail reports, their bands and controls. */
export function removeDetailReport(id: string) {
  mutate((r) => {
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of r.detailReports) if (d.parentId && doomed.has(d.parentId) && !doomed.has(d.id)) (doomed.add(d.id), (grew = true));
    }
    const bands = new Set(r.bands.filter((b) => b.detailReportId && doomed.has(b.detailReportId)).map((b) => b.id));
    r.detailReports = r.detailReports.filter((d) => !doomed.has(d.id));
    r.bands = r.bands.filter((b) => !bands.has(b.id));
    r.elements = r.elements.filter((e) => !bands.has(e.bandId));
  });
  state.selection = state.selection.filter((sid) => !!findElement(sid));
  if (state.selectedBandId && !findBand(state.selectedBandId)) state.selectedBandId = null;
}

/** Add / remove the header or footer band of a detail report. */
export function toggleDetailReportBand(id: string, type: 'drHeader' | 'drFooter') {
  mutate((r) => {
    const b = r.bands.find((x) => x.type === type && x.detailReportId === id);
    if (b) {
      r.bands = r.bands.filter((x) => x !== b);
      r.elements = r.elements.filter((e) => e.bandId !== b.id);
    } else r.bands.push(newBand(type, id));
  });
}

/** Data source used by the controls of a band (a detail report's own source, otherwise the report's). */
export function dataSourceOfBand(bandId: string | null | undefined): string | null {
  const band = state.report.bands.find((b) => b.id === bandId);
  if (band?.detailReportId) return state.report.detailReports.find((d) => d.id === band.detailReportId)?.dataSourceId ?? null;
  return state.report.dataSourceId ?? state.report.dataSources[0]?.id ?? null;
}

/** For bands of a detail report: the data source of its parent rows (available as [Master.Field]). */
export function masterDataSourceOfBand(bandId: string | null | undefined): string | null {
  const band = state.report.bands.find((b) => b.id === bandId);
  if (!band?.detailReportId) return null;
  const d = state.report.detailReports.find((x) => x.id === band.detailReportId);
  if (!d || d.printMode !== 'perRow') return null;
  if (!d.parentId) return state.report.dataSourceId ?? null;
  return state.report.detailReports.find((x) => x.id === d.parentId)?.dataSourceId ?? null;
}

// ------------------------------------------------------------------ table header row
/** A multi-row table in a repeating band whose top row is captions (static text) → that row prints for every record. */
export function tableHeaderRepeats(el: ReportElement | null | undefined): boolean {
  if (!el || el.type !== 'table' || el.rows.length < 2) return false;
  const band = state.report.bands.find((b) => b.id === el.bandId);
  if (!band || (band.type !== 'detail' && band.type !== 'groupFooter' && band.type !== 'drDetail')) return false;
  const first = el.rows[0].cells;
  return first.some((c) => c.text.trim()) && first.every((c) => !c.expression);
}

/**
 * Split off the top row of a table into its own table in the Page Header (or a group header),
 * so captions print once per page / group and only the data rows repeat.
 */
export function moveTableHeaderRow(tableId: string, target: 'pageHeader' | 'section' | string = 'pageHeader') {
  const src = findElement(tableId);
  if (!src || src.type !== 'table' || src.rows.length < 2) return;
  let newId = '';
  mutate((r) => {
    const t = r.elements.find((e) => e.id === tableId) as TableElement;
    const own = r.bands.find((b) => b.id === t.bandId);
    let band: Band | undefined;
    if (target === 'section' && own?.detailReportId) {
      // a table inside a detail report: its header row goes to that section's header band
      band = r.bands.find((b) => b.type === 'drHeader' && b.detailReportId === own.detailReportId);
      if (!band) {
        band = newBand('drHeader', own.detailReportId, t.rows[0].height);
        r.bands.push(band);
      }
    } else band = target === 'pageHeader' || target === 'section' ? r.bands.find((b) => b.type === 'pageHeader') : r.bands.find((b) => b.id === target);
    if (!band) {
      band = newBand('pageHeader', undefined, t.rows[0].height + 4);
      r.bands.push(band);
    }
    const bandWasEmpty = !r.elements.some((e) => e.bandId === band!.id);
    const bottom = Math.max(0, ...r.elements.filter((e) => e.bandId === band!.id).map((e) => e.y + e.height));
    const header = deepClone(t);
    header.id = uid('e');
    header.bandId = band.id;
    header.rows = [header.rows[0]];
    normalizeSpans(header);
    header.height = header.rows[0].height;
    header.y = bottom > 0 ? Math.ceil(bottom) : 0;
    header.canGrow = false;
    const taken = new Set(r.elements.map((e) => e.name));
    let n = 1;
    while (taken.has('tableHeader' + n)) n++;
    header.name = 'tableHeader' + n;
    r.elements.push(header);
    newId = header.id;
    // the data rows stay where the table was
    t.rows.shift();
    normalizeSpans(t);
    t.height = t.rows.reduce((a, b) => a + b.height, 0);
    // header directly above the data: a page header that only holds the header row is exactly that tall
    if (bandWasEmpty) {
      header.y = 0;
      band.height = header.height;
    }
    ensureBandFits(r, band.id);
    // the data row starts at the top of its band (when nothing is above it) and the band fits it,
    // so repeated rows form one continuous grid
    const others = r.elements.filter((e) => e.bandId === t.bandId && e.id !== t.id);
    if (!others.some((e) => e.y < t.y)) t.y = 0;
    const dataBand = r.bands.find((b) => b.id === t.bandId);
    if (dataBand) {
      const need = Math.max(4, ...r.elements.filter((e) => e.bandId === dataBand.id).map((e) => e.y + e.height));
      if (need < dataBand.height) dataBand.height = Math.ceil(need);
    }
  });
  state.selection = [newId];
  state.selectedCell = null;
  const inSection = !!state.report.bands.find((b) => b.id === findElement(newId)?.bandId)?.detailReportId;
  notify(inSection ? 'Header row moved to the section header — it prints once above this section’s rows' : 'Header row moved — it now prints once per page; the data row repeats for every record', 'success');
}

// ------------------------------------------------------------------ totals (grand total / group total / section total)
/** A footer band that summarizes the rows of a repeating band. bandId null = the band does not exist yet. */
export interface TotalTarget {
  kind: 'report' | 'group' | 'section';
  bandId: string | null;
  groupId?: string;
  drId?: string;
  label: string;
}

/** Where totals of a control in a repeating band (Detail / section Detail) can go. */
export function totalTargets(bandId: string): TotalTarget[] {
  const r = state.report;
  const band = r.bands.find((b) => b.id === bandId);
  if (!band) return [];
  if (band.type === 'detail') {
    const out: TotalTarget[] = [{ kind: 'report', bandId: r.bands.find((b) => b.type === 'reportFooter')?.id ?? null, label: 'Grand Total (Report Footer)' }];
    r.groups.forEach((g, i) => {
      const f = r.bands.find((b) => b.type === 'groupFooter' && b.groupId === g.id);
      out.push({ kind: 'group', groupId: g.id, bandId: f?.id ?? null, label: `Group Total — ${g.expression || 'Group ' + (i + 1)} (Group Footer)` });
    });
    return out;
  }
  if (band.type === 'drDetail' && band.detailReportId) {
    const f = r.bands.find((b) => b.type === 'drFooter' && b.detailReportId === band.detailReportId);
    return [{ kind: 'section', drId: band.detailReportId, bandId: f?.id ?? null, label: 'Section Total (Section Footer)' }];
  }
  return [];
}

const SUMMARY_BANDS: BandType[] = ['reportHeader', 'reportFooter', 'groupHeader', 'groupFooter', 'drHeader', 'drFooter', 'pageHeader', 'pageFooter'];
/** A label / table in a header or footer band: its values can be turned into totals in place. */
export function inSummaryBand(el: ReportElement | null | undefined): boolean {
  if (!el || (el.type !== 'table' && el.type !== 'text')) return false;
  const band = state.report.bands.find((b) => b.id === el.bandId);
  return !!band && SUMMARY_BANDS.includes(band.type);
}

/** Does an expression produce numbers (field type, or the values of the first rows)? */
function numericInfo(expr: string, dsId: string | null): { numeric: boolean; decimals: boolean } {
  const e = expr.trim();
  if (!e) return { numeric: false, decimals: false };
  const single = /^\[([^\]]+)\]$/.exec(e);
  const field = single && dsId ? fieldsOf(dsId).find((f) => f.name.toLowerCase() === single[1].trim().toLowerCase()) : undefined;
  const ctx: EvalContext = { row: null, rows: [], params: paramValues(state.report, toRaw(state.paramValues)), calc: compileCalcFields(toRaw(state.report)) };
  const vals = rowsFor(dsId)
    .slice(0, 60)
    .map((row) => evalExpr(e, { ...ctx, row }))
    .filter((v) => v !== null && v !== undefined && v !== '');
  const nums = vals.filter((v) => typeof v === 'number') as number[];
  const numeric = field ? field.type === 'number' : vals.length > 0 && nums.length === vals.length;
  return { numeric, decimals: nums.some((n) => !Number.isInteger(n)) };
}

const totalLabel = (bandType: BandType | undefined) =>
  bandType === 'reportFooter' || bandType === 'reportHeader' ? 'Grand Total' : bandType === 'pageFooter' || bandType === 'pageHeader' ? 'Page Total' : 'Total';

/** Turn one row of cells into totals: numbers -> Sum, other fields cleared, a caption in the first free cell. */
function totalRow(cells: TableCell[], dsId: string | null, label: string | null): TableCell[] {
  const out = cells.map((c): TableCell => {
    const style: StyleProps = { ...deepClone(c.style), bold: true };
    if (c.expression.trim() && c.summaryFunc !== 'none') return { ...deepClone(c), style };
    if (c.expression.trim()) {
      const inf = numericInfo(c.expression, dsId);
      if (inf.numeric) return { text: '', expression: c.expression, format: c.format || (inf.decimals ? 'n2' : 'n0'), summaryFunc: 'sum', style: { textAlign: 'right', ...style } };
      return { text: '', expression: '', format: '', summaryFunc: 'none', style };
    }
    return { ...deepClone(c), style };
  });
  if (label && !out.some((c) => !c.expression && c.text.trim())) {
    const firstNum = out.findIndex((c) => c.summaryFunc !== 'none');
    let li = out.findIndex((c, i) => !c.expression && (firstNum < 0 || i < firstNum));
    if (li < 0) li = out.findIndex((c) => !c.expression);
    if (li >= 0) out[li].text = label;
  }
  return out;
}

function makeTextTotal(t: TextElement, dsId: string | null): boolean {
  if (!t.expression.trim()) return false;
  if (t.summaryFunc === 'none') {
    const inf = numericInfo(t.expression, dsId);
    if (!inf.numeric) return false;
    t.summaryFunc = 'sum';
    t.summaryRunning = 'none';
    if (!t.format) t.format = inf.decimals ? 'n2' : 'n0';
    t.style.textAlign ??= 'right';
  }
  t.style.bold = true;
  return true;
}

/**
 * Add totals for the selected tables / labels of a Detail band into a footer band
 * (Report Footer = grand total, Group Footer = group total, Section Footer = section total).
 * A table in the footer that is a plain copy of the detail row is converted instead of adding another one.
 */
export function addTotals(target: TotalTarget, ids: string[] = state.selection) {
  const sources = ids.map(findElement).filter((e): e is ReportElement => !!e && (e.type === 'table' || e.type === 'text'));
  if (!sources.length) return;
  const dsId = dataSourceOfBand(sources[0].bandId);
  let made = 0;
  let newIds: string[] = [];
  mutate((r) => {
    let band = target.bandId ? r.bands.find((b) => b.id === target.bandId) : undefined;
    if (!band) {
      band = target.kind === 'report' ? newBand('reportFooter') : target.kind === 'group' ? newBand('groupFooter', target.groupId) : newBand('drFooter', target.drId);
      r.bands.push(band);
    }
    const fb = band;
    const label = target.kind === 'report' ? 'Grand Total' : 'Total';
    const existing = r.elements.filter((e) => e.bandId === fb.id);
    let y = existing.length ? Math.ceil(Math.max(...existing.map((e) => e.y + e.height))) : 0;
    const rowY = y;
    let labelDone = false;
    let rowH = 0;
    for (const src of sources) {
      if (src.type === 'table') {
        const dataRow = [...src.rows].reverse().find((row) => row.cells.some((c) => c.expression.trim())) ?? src.rows[src.rows.length - 1];
        const exprs = dataRow.cells.map((c) => c.expression.trim()).join('\u0001');
        // the footer already holds a copy of this row (e.g. pasted) -> convert that copy
        const copy = existing.find(
          (e): e is TableElement =>
            e.type === 'table' && Math.abs(e.x - src.x) < 3 && e.columns.length === src.columns.length && e.rows.some((row) => row.cells.map((c) => c.expression.trim()).join('\u0001') === exprs),
        );
        if (copy) {
          copy.rows = copy.rows.map((row, i) => (row.cells.some((c) => c.expression.trim()) ? { ...row, cells: totalRow(row.cells, dsId, i === 0 || !labelDone ? label : null) } : row));
          labelDone = true;
          newIds.push(copy.id);
          made++;
          continue;
        }
        const t = deepClone(src) as TableElement;
        t.id = uid('e');
        t.bandId = fb.id;
        t.name = uniqueName(r, 'totals');
        t.rows = [{ height: dataRow.height, cells: totalRow(dataRow.cells, dsId, labelDone ? null : label) }];
        normalizeSpans(t);
        t.height = dataRow.height;
        t.canGrow = false;
        t.y = y;
        y += t.height;
        r.elements.push(t);
        newIds.push(t.id);
        labelDone = true;
        made++;
      } else if (src.type === 'text') {
        const t = deepClone(src) as TextElement;
        if (!makeTextTotal(t, dsId)) continue;
        t.id = uid('e');
        t.bandId = fb.id;
        t.name = uniqueName(r, 'total');
        t.canGrow = false;
        t.y = rowY;
        rowH = Math.max(rowH, t.height);
        r.elements.push(t);
        newIds.push(t.id);
        made++;
      }
    }
    // labels: one caption left of the leftmost total (when there is room)
    const texts = newIds.map((id) => r.elements.find((e) => e.id === id)).filter((e): e is TextElement => e?.type === 'text');
    if (texts.length && !labelDone) {
      const left = texts.reduce((a, b) => (b.x < a.x ? b : a));
      if (left.x >= 60) {
        const cap = createElement('text', fb.id, Math.max(0, left.x - 110), rowY, r.elements, {
          name: uniqueName(r, 'totalCaption'),
          width: Math.min(106, left.x),
          height: left.height,
          style: { ...deepClone(left.style), bold: true, textAlign: 'right' },
        } as Partial<ReportElement>) as TextElement;
        cap.x = Math.max(0, left.x - cap.width - 4);
        cap.text = label;
        cap.expression = '';
        cap.summaryFunc = 'none';
        r.elements.push(cap);
        newIds.push(cap.id);
      }
    }
    void rowH;
    ensureBandFits(r, fb.id);
  });
  if (!made) {
    notify('No numeric fields to total in the selection — totals need number fields (e.g. amounts, quantities)', 'error');
    return;
  }
  newIds = newIds.filter((id) => !!findElement(id));
  state.selection = newIds;
  state.selectedCell = null;
  notify(`${target.kind === 'report' ? 'Grand total' : target.kind === 'group' ? 'Group total' : 'Section total'} added — number columns use Sum(); change it per cell in Properties ▸ Summary`, 'success');
}

/** Turn the selected labels / tables of a header or footer band into totals (numbers -> Sum). */
export function convertToTotals(ids: string[] = state.selection) {
  let made = 0;
  mutate((r) => {
    for (const id of ids) {
      const el = r.elements.find((e) => e.id === id);
      if (!el || !inSummaryBand(el)) continue;
      const band = r.bands.find((b) => b.id === el.bandId);
      const dsId = dataSourceOfBand(el.bandId);
      if (el.type === 'table') {
        let labelDone = false;
        el.rows = el.rows.map((row) => {
          if (!row.cells.some((c) => c.expression.trim())) return row;
          const cells = totalRow(row.cells, dsId, labelDone ? null : totalLabel(band?.type));
          labelDone = true;
          made += cells.filter((c) => c.summaryFunc !== 'none').length;
          return { ...row, cells };
        });
      } else if (el.type === 'text' && makeTextTotal(el, dsId)) made++;
    }
  });
  if (made) notify('Totals: number values now show Sum() over ' + (bandScopeText(ids[0]) || 'the rows'), 'success');
  else notify('No numeric fields found to total — totals need number fields', 'error');
}

function bandScopeText(id: string | undefined) {
  const el = id ? findElement(id) : null;
  const band = el ? state.report.bands.find((b) => b.id === el.bandId) : null;
  switch (band?.type) {
    case 'reportFooter':
    case 'reportHeader':
      return 'all rows (grand total)';
    case 'groupFooter':
    case 'groupHeader':
      return 'each group';
    case 'drFooter':
    case 'drHeader':
      return 'the section rows';
    case 'pageFooter':
    case 'pageHeader':
      return 'the rows on each page';
  }
  return '';
}

/** Current summary function of the selected cell / label. */
export function selectedSummary(): SummaryFunc | null {
  const el = state.selection.length === 1 ? findElement(state.selection[0]) : null;
  if (!el) return null;
  if (el.type === 'table' && state.selectedCell?.id === el.id) return el.rows[state.selectedCell.row]?.cells[state.selectedCell.col]?.summaryFunc ?? null;
  if (el.type === 'text') return el.summaryFunc;
  return null;
}

/** Set Sum / Count / Avg / Min / Max (or none) on the selected table cell or labels. */
export function setSummary(fn: SummaryFunc) {
  const cell = state.selectedCell;
  mutate((r) => {
    for (const id of state.selection) {
      const el = r.elements.find((e) => e.id === id);
      if (!el) continue;
      if (el.type === 'table' && cell?.id === el.id) {
        const c = el.rows[cell.row]?.cells[cell.col];
        if (c && c.expression.trim()) c.summaryFunc = fn;
      } else if (el.type === 'text' && el.expression.trim()) el.summaryFunc = fn;
    }
  });
}

// ------------------------------------------------------------------ merged cells
/** The selected cell range of the selected table (one cell when nothing more is selected). */
export function selectedRange(): { el: TableElement; rg: CellRange } | null {
  const c = state.selectedCell;
  if (!c) return null;
  const el = findElement(c.id);
  if (!el || el.type !== 'table') return null;
  return { el, rg: rangeOf(el, { row: c.row, col: c.col }, { row: c.row2 ?? c.row, col: c.col2 ?? c.col }) };
}
/** Positions of the selected cells inside a (mutable) table — merged cells once. */
function selectedCellsOf(t: TableElement): CellPos[] {
  const c = state.selectedCell;
  if (!c || c.id !== t.id) return [];
  return cellsIn(t, rangeOf(t, { row: c.row, col: c.col }, { row: c.row2 ?? c.row, col: c.col2 ?? c.col }));
}
export const canMergeCells = () => {
  const s = selectedRange();
  return !!s && (s.rg.r1 > s.rg.r0 || s.rg.c1 > s.rg.c0) && cellsIn(s.el, s.rg).length > 1;
};
export const canUnmergeCells = () => {
  const s = selectedRange();
  return !!s && cellsIn(s.el, s.rg).some((p) => {
    const sp = spanOf(s.el.rows[p.row].cells[p.col]);
    return sp.cs > 1 || sp.rs > 1;
  });
};

/** Merge the selected cells (Shift+click / drag across cells first). */
export function mergeCells() {
  const s = selectedRange();
  if (!s) return notify('Select a table cell first');
  if (!canMergeCells()) return notify('Select two or more cells to merge: Shift+click another cell, or drag across the cells');
  let dropped = 0;
  mutate((r) => {
    const t = r.elements.find((e) => e.id === s.el.id) as TableElement;
    dropped = mergeRange(t, s.rg);
    normalizeSpans(t);
  });
  state.selectedCell = { id: s.el.id, row: s.rg.r0, col: s.rg.c0 };
  notify(dropped ? `Cells merged — kept the content of the first cell (${dropped} other cell(s) had content)` : 'Cells merged', 'success');
}
/** Merge the selected cell with the next cell to the right or below. */
export function mergeCellWith(dir: 'right' | 'down') {
  const s = selectedRange();
  if (!s) return;
  const { el, rg } = s;
  if (dir === 'right' && rg.c1 + 1 >= el.columns.length) return notify('There is no cell to the right');
  if (dir === 'down' && rg.r1 + 1 >= el.rows.length) return notify('There is no cell below');
  const end = rangeOf(el, { row: rg.r0, col: rg.c0 }, dir === 'right' ? { row: rg.r1, col: rg.c1 + 1 } : { row: rg.r1 + 1, col: rg.c1 });
  state.selectedCell = { id: el.id, row: end.r0, col: end.c0, row2: end.r1, col2: end.c1 };
  mergeCells();
}
/** Split merged cells in the selection back into single cells. */
export function unmergeCells() {
  const s = selectedRange();
  if (!s || !canUnmergeCells()) return notify('The selected cell is not merged');
  mutate((r) => {
    const t = r.elements.find((e) => e.id === s.el.id) as TableElement;
    unmergeRange(t, s.rg);
  });
  notify('Cells unmerged', 'success');
}

// ------------------------------------------------------------------ table column layout
/** Integer widths that add up exactly to `total` (rounding goes to the last column). */
function exactWidths(ws: number[], total: number): number[] {
  const out = ws.map((w) => Math.max(8, Math.round(w)));
  out[out.length - 1] = Math.max(8, out[out.length - 1] + Math.round(total) - out.reduce((a, b) => a + b, 0));
  return out;
}
const tableIdOf = (id?: string) => {
  const el = findElement(id ?? state.selectedCell?.id ?? primaryElement.value?.id ?? '');
  return el?.type === 'table' ? el : null;
};

/** Equal column widths — all columns, or only the columns of the selected cell range. The table keeps its width. */
export function equalizeColumns(tableId?: string) {
  const t = tableIdOf(tableId);
  if (!t) return notify('Select a table first');
  const sc = state.selectedCell?.id === t.id ? state.selectedCell : null;
  const rg = sc ? rangeOf(t, { row: sc.row, col: sc.col }, { row: sc.row2 ?? sc.row, col: sc.col2 ?? sc.col }) : null;
  const [c0, c1] = rg && rg.c1 > rg.c0 ? [rg.c0, rg.c1] : [0, t.columns.length - 1];
  mutate((r) => {
    const el = r.elements.find((e) => e.id === t.id) as TableElement;
    const part = el.columns.slice(c0, c1 + 1);
    const total = part.reduce((a, b) => a + b, 0);
    const eq = exactWidths(part.map(() => total / part.length), total);
    el.columns.splice(c0, part.length, ...eq);
    el.width = el.columns.reduce((a, b) => a + b, 0);
  });
  notify(c1 - c0 + 1 === t.columns.length ? 'All columns have the same width now' : `Columns ${c0 + 1}–${c1 + 1} have the same width now`, 'success');
}

/**
 * Give other tables the column lines of a reference table (the last selected one).
 * Same number of columns: identical widths. Fewer columns: each line moves to the nearest line of the reference.
 * More columns: the table takes the reference's position and width, lines snap to the reference where close.
 * Several tables selected: only those change; one table selected: all other tables of the report.
 */
export function matchTableColumns(refId?: string) {
  const ref = tableIdOf(refId);
  if (!ref) return notify('Select the table whose columns the others should follow');
  const selectedTables = selectedElements.value.filter((e) => e.type === 'table' && e.id !== ref.id).map((e) => e.id);
  const targets = (selectedTables.length ? selectedTables : state.report.elements.filter((e) => e.type === 'table' && e.id !== ref.id && !e.locked).map((e) => e.id));
  if (!targets.length) return notify('There is no other table to line up');
  const rb: number[] = [ref.x];
  ref.columns.forEach((w, i) => rb.push(rb[i] + w));
  const W = rb[rb.length - 1] - ref.x;
  mutate((r) => {
    for (const id of targets) {
      const t = r.elements.find((e) => e.id === id) as TableElement | undefined;
      if (!t || t.type !== 'table' || t.locked) continue;
      const n = t.columns.length;
      const m = ref.columns.length;
      let lines: number[];
      if (n === m) lines = [...rb];
      else {
        // the table's own lines, stretched onto the reference width
        const tw = t.columns.reduce((a, b) => a + b, 0) || 1;
        const own: number[] = [0];
        t.columns.forEach((w, i) => own.push(own[i] + (w / tw) * W));
        lines = own.map((v) => ref.x + v);
        if (n < m) {
          // every inner line goes to the nearest free reference line (keeping their order)
          let j = 0;
          for (let k = 1; k < n; k++) {
            let best = -1;
            for (let c = Math.max(j + 1, 1); c <= m - (n - k); c++) if (best < 0 || Math.abs(rb[c] - lines[k]) < Math.abs(rb[best] - lines[k])) best = c;
            lines[k] = rb[best];
            j = best;
          }
        } else
          for (let k = 1; k < n; k++) {
            const near = rb.reduce((b, v) => (Math.abs(v - lines[k]) < Math.abs(b - lines[k]) ? v : b), rb[0]);
            if (Math.abs(near - lines[k]) < 12 && near > lines[k - 1] + 8) lines[k] = near;
          }
        lines[0] = rb[0];
        lines[n] = rb[m];
      }
      t.x = Math.round(lines[0]);
      t.columns = exactWidths(
        lines.slice(1).map((v, i) => v - lines[i]),
        W,
      );
      t.width = t.columns.reduce((a, b) => a + b, 0);
    }
  });
  notify(`${targets.length} table${targets.length === 1 ? '' : 's'} lined up with the columns of ${ref.name}`, 'success');
}

/** Stretch a table over the full page width (from the left margin), keeping the column proportions. */
export function fitTableToPageWidth(tableId?: string) {
  const t = tableIdOf(tableId);
  if (!t) return notify('Select a table first');
  mutate((r) => {
    const el = r.elements.find((e) => e.id === t.id) as TableElement;
    const cw = contentWidth(r);
    const tw = el.columns.reduce((a, b) => a + b, 0) || 1;
    el.x = 0;
    el.columns = exactWidths(
      el.columns.map((w) => (w / tw) * cw),
      cw,
    );
    el.width = el.columns.reduce((a, b) => a + b, 0);
  });
}

// ------------------------------------------------------------------ table commands
export function tableOp(op: 'insertRowAbove' | 'insertRowBelow' | 'deleteRow' | 'insertColLeft' | 'insertColRight' | 'deleteCol') {
  const cell = state.selectedCell;
  if (!cell) return;
  const sel = { row: cell.row, col: cell.col };
  mutate((r) => {
    const el = r.elements.find((e) => e.id === cell.id) as TableElement | undefined;
    if (!el || el.type !== 'table') return;
    if (op === 'insertRowAbove' || op === 'insertRowBelow') {
      const span = spanOf(el.rows[cell.row].cells[cell.col]).rs;
      const at = op === 'insertRowBelow' ? cell.row + span : cell.row;
      const tmplRow = el.rows[Math.min(el.rows.length - 1, op === 'insertRowBelow' ? at - 1 : at)];
      insertRow(el, at, tmplRow.height, tmplRow.cells);
      if (op === 'insertRowAbove') sel.row++;
    } else if (op === 'deleteRow') {
      if (el.rows.length <= 1) return;
      deleteRow(el, cell.row);
      sel.row = Math.min(cell.row, el.rows.length - 1);
    } else if (op === 'insertColLeft' || op === 'insertColRight') {
      const span = spanOf(el.rows[cell.row].cells[cell.col]).cs;
      const ref = op === 'insertColRight' ? cell.col + span - 1 : cell.col;
      const at = op === 'insertColRight' ? ref + 1 : ref;
      const w = Math.max(30, Math.round(el.columns[ref] / 2));
      el.columns[ref] -= Math.min(w, el.columns[ref] - 10);
      insertCol(el, at, w);
      if (op === 'insertColLeft') sel.col++;
    } else if (op === 'deleteCol') {
      if (el.columns.length <= 1) return;
      deleteCol(el, cell.col);
      sel.col = Math.min(cell.col, el.columns.length - 1);
    }
    el.width = el.columns.reduce((a, b) => a + b, 0);
    el.height = el.rows.reduce((a, b) => a + b.height, 0);
    ensureBandFits(r, el.bandId);
    const o = ownerOf(el, sel.row, sel.col);
    state.selectedCell = { id: el.id, row: o.row, col: o.col };
  });
}

// ------------------------------------------------------------------ bands & groups
export function addBand(type: BandType) {
  if (type === 'groupHeader') return addGroup('');
  if (state.report.bands.some((b) => b.type === type)) {
    notify(`The report already has a ${type} band`);
    return;
  }
  mutate((r) => {
    r.bands.push(newBand(type));
  });
}
export function removeBand(id: string) {
  const b = findBand(id);
  if (!b) return;
  if (b.type === 'detail') {
    notify('The detail band cannot be removed');
    return;
  }
  if (b.type === 'drDetail' && b.detailReportId) {
    const d = state.report.detailReports.find((x) => x.id === b.detailReportId);
    if (!confirm(`Remove the section "${d?.name ?? 'Detail Report'}" with its header, footer, nested sections and controls?`)) return;
    removeDetailReport(b.detailReportId);
    return;
  }
  mutate((r) => {
    if (b.type === 'groupHeader') {
      r.groups = r.groups.filter((g) => g.id !== b.groupId);
      const ids = new Set(r.bands.filter((x) => x.groupId === b.groupId).map((x) => x.id));
      r.bands = r.bands.filter((x) => !ids.has(x.id));
      r.elements = r.elements.filter((e) => !ids.has(e.bandId));
    } else {
      r.bands = r.bands.filter((x) => x.id !== id);
      r.elements = r.elements.filter((e) => e.bandId !== id);
    }
  });
  if (state.selectedBandId === id) state.selectedBandId = null;
  state.selection = state.selection.filter((sid) => !!findElement(sid));
}
export function addGroup(expression: string, withFooter = true) {
  let gid = '';
  mutate((r) => {
    gid = uid('g');
    r.groups.push({ id: gid, expression, sort: 'asc', keepWithFirstDetail: true });
    r.bands.push(newBand('groupHeader', gid));
    if (withFooter) r.bands.push(newBand('groupFooter', gid));
  });
  return gid;
}
export function toggleGroupFooter(groupId: string) {
  mutate((r) => {
    const f = r.bands.find((b) => b.type === 'groupFooter' && b.groupId === groupId);
    if (f) {
      r.bands = r.bands.filter((b) => b !== f);
      r.elements = r.elements.filter((e) => e.bandId !== f.id);
    } else r.bands.push(newBand('groupFooter', groupId));
  });
}

// ------------------------------------------------------------------ data
export function mainDataSource() {
  return state.report.dataSources.find((d) => d.id === state.report.dataSourceId) ?? null;
}
export function rowsFor(dsId: string | null | undefined): Row[] {
  if (!dsId) return [];
  return dataCache[dsId] ?? [];
}
export const mainRows = computed(() => rowsFor(state.report.dataSourceId));

export function fieldsOf(dsId: string): FieldDef[] {
  const ds = state.report.dataSources.find((d) => d.id === dsId);
  if (!ds) return [];
  if (ds.fields?.length) return ds.fields;
  return inferFields(rowsFor(dsId));
}

const loading = new Map<string, Promise<void>>();
/** bumped when another report is opened, so late results of the previous report are dropped */
let dataGeneration = 0;
/** For database sources: definition + resolved parameter values the cached rows belong to. */
const dataKeys: Record<string, string> = {};

/** Evaluation context for data-source parameters (report parameter values). */
export function dataParamCtx() {
  return { params: paramValues(state.report, toRaw(state.paramValues)), reportName: state.report.name };
}
function dataKey(ds: DataSourceDef, ctx: ReturnType<typeof dataParamCtx>) {
  if (ds.kind !== 'sql' || !ds.sql) return 'static';
  return JSON.stringify([toRaw(ds.sql), resolveSqlParams(toRaw(ds.sql), ctx)]);
}

/** Load (or reload) data sources. Database sources re-query when their definition or parameter values change. */
export async function ensureData(force = false) {
  const ctx = dataParamCtx();
  const jobs = state.report.dataSources.map((ds) => {
    const key = dataKey(ds, ctx);
    if (!force && dataCache[ds.id] && dataKeys[ds.id] === key) return undefined;
    const busy = loading.get(ds.id);
    if (busy) return busy;
    const gen = dataGeneration;
    const self: { job?: Promise<void> } = {};
    const job: Promise<void> = (async () => {
      // yield first: in-memory sources finish synchronously, and the job must be registered before it ends
      await null;
      try {
        const raw = toRaw(ds);
        const rows = loadDataSourceSync(raw) ?? (await loadWithLogin(raw, ctx));
        if (gen !== dataGeneration) return; // another report was opened meanwhile
        dataCache[ds.id] = markRaw(rows);
        dataKeys[ds.id] = key;
        delete dataErrors[ds.id];
        if (!ds.fields?.length) {
          const f = inferFields(rows);
          const live = state.report.dataSources.find((d) => d.id === ds.id);
          if (live && f.length) live.fields = f;
        }
      } catch (e) {
        if (gen !== dataGeneration) return;
        dataErrors[ds.id] = (e as Error).message;
        dataCache[ds.id] = markRaw([]);
        delete dataKeys[ds.id];
      } finally {
        if (loading.get(ds.id) === self.job) loading.delete(ds.id);
        state.revision++;
      }
    })();
    self.job = job;
    loading.set(ds.id, job);
    return job;
  });
  await Promise.all(jobs);
}

/** Run a data source; when its database connection needs a password, ask for it and retry once. */
export async function loadWithLogin(ds: DataSourceDef, ctx: Partial<EvalContext>, maxRows?: number): Promise<Row[]> {
  try {
    return await loadDataSource(ds, ctx, maxRows);
  } catch (e) {
    if (e instanceof DbError && e.needLogin && e.connectionId) {
      if (await requestLogin(e.connectionId, e.connectionName ?? ds.sql?.connectionName ?? '')) return await loadDataSource(ds, ctx, maxRows);
    }
    throw e;
  }
}
export function invalidateData(dsId: string) {
  delete dataCache[dsId];
  delete dataKeys[dsId];
  void ensureData();
}

// ------------------------------------------------------------------ database login prompts
export interface LoginRequest {
  connectionId: string;
  name: string;
  resolve: (ok: boolean) => void;
}
const pendingLogins = new Map<string, Promise<boolean>>();
/** Ask the user for the password of a database connection. Resolves true once logged in. */
export function requestLogin(connectionId: string, name: string): Promise<boolean> {
  let p = pendingLogins.get(connectionId);
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      state.loginRequests.push({
        connectionId,
        name,
        resolve: (ok) => {
          pendingLogins.delete(connectionId);
          resolve(ok);
        },
      });
    });
    pendingLogins.set(connectionId, p);
  }
  return p;
}

// ------------------------------------------------------------------ file
export function loadReport(def: ReportDef, fileName?: string) {
  const r = normalizeReport(def);
  undoStack.length = 0;
  redoStack.length = 0;
  syncHistoryFlags();
  for (const k of Object.keys(dataCache)) delete dataCache[k];
  for (const k of Object.keys(dataKeys)) delete dataKeys[k];
  loading.clear();
  dataGeneration++;
  state.report = r;
  state.selection = [];
  state.selectedBandId = null;
  state.selectedCell = null;
  state.paramValues = {};
  state.fileName = fileName ?? (r.name || 'report') + '.rptx';
  state.dirty = false;
  state.revision++;
  void ensureData();
}

export function newReportCmd() {
  if (state.dirty && !confirm('Discard unsaved changes and create a new report?')) return;
  loadReport(newReport(), 'report.rptx');
}

export function serializeReport(): string {
  return JSON.stringify(toRaw(state.report), null, 2);
}

/** File formats: .rptx (ReportTool JSON), .html (the printed report + its design), .rdl (SQL Server Reporting Services). */
export type SaveFormat = 'rptx' | 'html' | 'rdl';
export const SAVE_FORMATS: Record<SaveFormat, { ext: string; mime: string; desc: string; extra: string[] }> = {
  rptx: { ext: '.rptx', mime: 'application/json', desc: 'ReportTool report', extra: ['.json'] },
  html: { ext: '.html', mime: 'text/html', desc: 'HTML page (report with data + design)', extra: ['.htm'] },
  rdl: { ext: '.rdl', mime: 'application/xml', desc: 'RDL report (SQL Server Reporting Services / Report Builder)', extra: ['.rdlc'] },
};
export function formatOf(name: string): SaveFormat {
  const n = name.toLowerCase();
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'html';
  if (n.endsWith('.rdl') || n.endsWith('.rdlc')) return 'rdl';
  return 'rptx';
}
const baseOf = (name: string) => name.replace(/\.[^.]+$/, '') || 'report';

/** The rendered report (current data and parameter values) — used by Save as HTML. */
async function renderCurrent() {
  await ensureData();
  await ensureReportFonts(state.report);
  const data: Record<string, Row[]> = {};
  for (const ds of state.report.dataSources) data[ds.id] = rowsFor(ds.id);
  return renderReport({ report: toRaw(state.report), data, params: paramValues(state.report, toRaw(state.paramValues)) });
}

/** The report as text in a format (JSON design, RDL XML, HTML page). RDL can produce extra files (subreports). */
export async function buildText(format: SaveFormat, base = baseOf(state.fileName)): Promise<{ text: string; mime: string; extra: { name: string; text: string }[]; warnings: string[] }> {
  const out = await buildFile(format, base);
  return { text: await out.blob.text(), mime: SAVE_FORMATS[format].mime, extra: out.extra, warnings: out.warnings };
}

/** Build the file content for a format. RDL can produce extra files (subreports of "per row" sections). */
async function buildFile(format: SaveFormat, base: string): Promise<{ blob: Blob; extra: { name: string; text: string }[]; warnings: string[] }> {
  const def = deepClone(toRaw(state.report));
  if (format === 'html') {
    const ex = await import('../export');
    const doc = await renderCurrent();
    const html = await ex.exportHtmlFile(doc, state.report.name || base, def);
    return { blob: new Blob([html], { type: 'text/html' }), extra: [], warnings: doc.warnings ?? [] };
  }
  if (format === 'rdl') {
    // RDL keeps database queries as queries: only in-memory sources (JSON / CSV / sample) are embedded,
    // so saving never needs a database login
    const { exportRdl } = await import('../export/rdl');
    const connections = await listConnections().catch(() => []);
    const rows = (id: string) => {
      const cached = rowsFor(id);
      if (cached.length) return cached;
      const ds = def.dataSources.find((d) => d.id === id);
      return (ds && ds.kind !== 'sql' && loadDataSourceSync(ds)) || [];
    };
    const res = await exportRdl(def, { baseName: base, rows, connections, embedDefinition: true });
    return {
      blob: new Blob([res.files[0].xml], { type: 'application/xml' }),
      extra: res.files.slice(1).map((f) => ({ name: f.name, text: f.xml })),
      warnings: res.warnings,
    };
  }
  return { blob: new Blob([serializeReport()], { type: 'application/json' }), extra: [], warnings: [] };
}

/**
 * Save (Ctrl+S) / Save as (Ctrl+Shift+S). `format` switches the file type (Save as HTML / RDL);
 * afterwards Ctrl+S keeps saving that file in that format (HTML and RDL files keep the full design inside).
 */
export async function saveReport(saveAs = false, format?: SaveFormat) {
  const cur = formatOf(state.fileName);
  const fmt = format ?? cur;
  const info = SAVE_FORMATS[fmt];
  let name = baseOf(state.fileName) + info.ext;
  const anyWin = window as any;
  let handle = fmt === cur ? (state as any)._handle : null;
  try {
    if (anyWin.showSaveFilePicker && (saveAs || !handle)) {
      handle = await anyWin.showSaveFilePicker({ suggestedName: name, types: [{ description: info.desc, accept: { [info.mime]: [info.ext, ...info.extra] } }] });
      name = handle.name;
    }
    const out = await buildFile(fmt, baseOf(name));
    const { downloadBlob } = await import('../export');
    if (handle) {
      const w = await handle.createWritable();
      await w.write(out.blob);
      await w.close();
    } else downloadBlob(out.blob, name);
    if (out.extra.length) {
      // subreports must sit next to the main .rdl: deliver them together in a zip
      const { zipSync, strToU8 } = await import('fflate');
      const files: Record<string, Uint8Array> = {};
      files[name] = new Uint8Array(await out.blob.arrayBuffer());
      for (const f of out.extra) files[f.name] = strToU8(f.text);
      downloadBlob(new Blob([zipSync(files) as BlobPart], { type: 'application/zip' }), baseOf(name) + '_rdl.zip');
    }
    (state as any)._handle = handle ? markRaw(handle) : null;
    state.fileName = name;
    state.dirty = false;
    notify(`Saved ${name}`, 'success');
    // explain the result after "Save as HTML / RDL" (plain Ctrl+S stays quiet)
    if (fmt !== 'rptx' && (format || out.extra.length)) {
      openDialog('saveInfo', {
        title: fmt === 'rdl' ? 'Saved as RDL' : 'Saved as HTML',
        note:
          fmt === 'rdl'
            ? 'Open the .rdl file in Report Builder, Power BI Report Builder or a Visual Studio report project, or upload it to a Report Server. ReportTool can open it again (the full design is stored inside).'
            : 'The HTML page shows the report with the current data and prints page by page from any browser. Open it in ReportTool to keep editing the design.',
        files: [name, ...(out.extra.length ? [...out.extra.map((f) => f.name), baseOf(name) + '_rdl.zip (all files together)'] : [])],
        warnings: out.warnings,
      });
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') notify('Save failed: ' + (e as Error).message, 'error');
  }
}
export const saveReportAs = (format: SaveFormat) => saveReport(true, format);

/**
 * A report design from text: ReportTool JSON, RDL XML (ReportTool's own or from SSRS / Report Builder) or an HTML page
 * saved by ReportTool. The format is taken from the name / hint, otherwise recognised from the text.
 */
export async function parseReportText(text: string, name = 'report', hint?: SaveFormat): Promise<{ def: ReportDef; warnings: string[] }> {
  const t = text.replace(/^﻿/, '');
  let fmt = hint ?? formatOf(name);
  if (!hint && fmt === 'rptx') {
    if (/^\s*(<\?xml|<Report\b)/.test(t)) fmt = 'rdl';
    else if (/^\s*(<!doctype html|<html\b)/i.test(t)) fmt = 'html';
  }
  let def: ReportDef | null = null;
  let warnings: string[] = [];
  if (fmt === 'rdl') {
    const { extractDefinition } = await import('../export/rdl');
    const own = extractDefinition(t);
    const useOwn =
      own &&
      (!own.modified ||
        !confirm(
          `"${name}" was changed in another program (e.g. Report Builder) after ReportTool saved it.\n\nOK = import the RDL as it is now (its current layout)\nCancel = open the ReportTool design saved inside the file`,
        ));
    if (own && useOwn) def = own.def;
    else {
      const { importRdl } = await import('../import/rdl');
      const res = importRdl(t, name, await listConnections().catch(() => []));
      def = res.report;
      warnings = res.warnings;
    }
  } else if (fmt === 'html') {
    const { readHtmlDefinition } = await import('../export');
    def = readHtmlDefinition(t) as ReportDef | null;
    if (!def) throw new Error('this HTML page was not saved by ReportTool (it contains no report design)');
  } else def = JSON.parse(t) as ReportDef;
  if (!def || !Array.isArray(def.bands) || !Array.isArray(def.elements)) throw new Error('Not a ReportTool report');
  return { def, warnings };
}

export async function openReportFile(file: File) {
  try {
    const { def, warnings } = await parseReportText(await file.text(), file.name);
    (state as any)._handle = null;
    loadReport(def, file.name);
    notify('Opened ' + file.name, 'success');
    if (warnings.length) openDialog('saveInfo', { title: 'Imported RDL report', note: 'The RDL report was converted into a ReportTool design. Check these points:', files: [], warnings });
  } catch (e) {
    notify('Open failed: ' + (e as Error).message, 'error');
  }
}

export function pickReportFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.rptx,.json,.rdl,.rdlc,.html,.htm,application/json';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (f) {
      if (state.dirty && !confirm('Discard unsaved changes?')) return;
      openReportFile(f);
    }
  };
  inp.click();
}

// ------------------------------------------------------------------ dialogs
export function openDialog(type: DialogType, props?: any) {
  state.dialog = type;
  state.dialogProps = props ?? null;
}
export function closeDialog() {
  state.dialog = null;
  state.dialogProps = null;
}
export function editExpression(value: string, title = 'Expression Editor'): Promise<string | null> {
  return new Promise((resolve) => {
    state.exprRequest = { value, title, resolve };
  });
}

// ------------------------------------------------------------------ autosave
let saveTimer: number | undefined;
watch(
  () => state.revision,
  () => {
    clearTimeout(saveTimer);
    if (state.embedded) return; // the host system keeps the reports
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ fileName: state.fileName, report: toRaw(state.report) }));
      } catch {
        /* storage full or unavailable */
      }
    }, 800);
  },
);
/**
 * Called once at start-up. The designer always opens on a blank page; the auto-saved report of the
 * previous session (if it has any content) is parked under a separate key and can be restored on demand.
 */
export function stashPreviousSession(): { name: string; count: number } | null {
  try {
    localStorage.removeItem('reporttool.autosave.v1');
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      localStorage.setItem(PREVIOUS_KEY, raw);
      localStorage.removeItem(AUTOSAVE_KEY);
    }
    const prev = localStorage.getItem(PREVIOUS_KEY);
    if (!prev) return null;
    const { report } = JSON.parse(prev);
    if (!report?.bands || !report.elements?.length) return null;
    return { name: report.name || 'Report', count: report.elements.length };
  } catch {
    return null;
  }
}
export function restorePreviousSession(): boolean {
  try {
    const raw = localStorage.getItem(PREVIOUS_KEY);
    if (!raw) return false;
    const { fileName, report } = JSON.parse(raw);
    if (!report?.bands) return false;
    loadReport(report, fileName);
    state.dirty = true;
    localStorage.removeItem(PREVIOUS_KEY);
    return true;
  } catch {
    return false;
  }
}
export function discardPreviousSession() {
  try {
    localStorage.removeItem(PREVIOUS_KEY);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ page size
/** Change page settings. Sizes coming from the UI are in millimetres. */
export function setPageProp(path: string, value: unknown) {
  mutate((r) => {
    const p = r.page;
    switch (path) {
      case 'page.paper':
        applyPaper(p, String(value));
        break;
      case 'page.orientation':
        applyOrientation(p, value === 'landscape' ? 'landscape' : 'portrait');
        break;
      case 'page.baseWidth':
        setCustomPageSize(p, mmToPx(Number(value)), p.height);
        break;
      case 'page.height':
        setCustomPageSize(p, p.baseWidth ?? p.width, mmToPx(Number(value)));
        break;
      case 'page.margins':
        if (MARGIN_PRESETS[String(value)]) {
          const m = mmToPx(MARGIN_PRESETS[String(value)].mm);
          p.margins = { top: m, right: m, bottom: m, left: m };
        }
        break;
      case 'page.margins.top':
      case 'page.margins.right':
      case 'page.margins.bottom':
      case 'page.margins.left':
        p.margins[path.slice(13) as 'top'] = Math.max(0, mmToPx(Number(value)));
        break;
      case 'page.autoWidth':
        p.autoWidth = !!value;
        break;
      case 'page.autoHeight':
        p.autoHeight = !!value;
        break;
    }
  }, 'page:' + path);
}

/** Set the paper width exactly to the content (widest control + margins). */
export function fitPageWidthToContent() {
  if (!state.report.elements.length) {
    notify('Add some controls first');
    return;
  }
  mutate((r) => {
    const need = Math.ceil(contentRight(r) + r.page.margins.left + r.page.margins.right);
    setCustomPageSize(r.page, Math.max(mmToPx(30), need), r.page.height);
  });
  notify('Page width fitted to content');
}

export const visibleBands = computed(() => orderedBands(state.report));
