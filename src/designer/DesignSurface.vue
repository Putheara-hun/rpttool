<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Columns3,
  Database,
  Hash,
  Layers,
  Paintbrush,
  Lock,
  LockOpen,
  Minus,
  MoreHorizontal,
  Pencil,
  Rows3,
  Scissors,
  SendToBack,
  Settings,
  Shrink,
  Sigma,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  ArrowLeft,
  ArrowRight,
  Table2,
} from 'lucide-vue-next';
import ElementView from './ElementView.vue';
import FieldPicker from './FieldPicker.vue';
import { specialFields } from './specialFields';
import { bandCaption, contentWidth, crosstabSize, syncCrosstabSize, type ToolId } from '../model/defaults';
import { cellOwners, cellRectOf, columnMoveOrder, ownerOf, rangeOf } from '../model/table';
import type { Band, CrosstabElement, ReportElement, SummaryFunc, TableElement } from '../model/types';
import {
  addBand,
  addDetailReport,
  addElement,
  applyFormatBrush,
  bindToField,
  notify,
  clipboardText,
  hasClipboard,
  parseClipboardText,
  pasteFromSystem,
  pasteImage,
  pastePayload,
  pasteText,
  startFormatPainter,
  writeSystemClipboard,
  type PasteTarget,
  dataSourceOfBand,
  masterDataSourceOfBand,
  toggleDetailReportBand,
  clearBinding,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  editExpression,
  findElement,
  fitBandToContent,
  moveElements,
  moveTableHeaderRow,
  addTotals,
  equalizeColumns,
  fitTableToPageWidth,
  matchTableColumns,
  endLive,
  mutateLive,
  canMergeCells,
  canUnmergeCells,
  mergeCells,
  mergeCellWith,
  unmergeCells,
  convertToTotals,
  inSummaryBand,
  selectedSummary,
  setSummary,
  totalTargets,
  mutate,
  openDialog,
  pasteClipboard,
  removeBand,
  resizeElements,
  select,
  selectBand,
  selectedElements,
  setBandProp,
  setElementProp,
  state,
  tableOp,
  visibleBands,
  zOrder,
  linkedTables,
  moveTableColumn,
  setCrosstabField,
  CROSSTAB_LABEL,
  CROSSTAB_PROP,
  type CrosstabZone,
  type FieldChoice,
} from '../store/designer';
import { applyLineStyle, openContextMenu, type MenuItem } from './ui';
import { resolveStyle, PT } from '../model/defaults';

const CAP = 20;
const PAD = 24;
const RULER = 22;

const scroller = ref<HTMLElement>();
const pageEl = ref<HTMLElement>();
const z = computed(() => state.zoom);
const pg = computed(() => state.report.page);
const ml = computed(() => pg.value.margins.left);
const mr = computed(() => pg.value.margins.right);
const cw = computed(() => contentWidth(state.report));

const bandPreview = ref<{ id: string; h: number } | null>(null);

interface BandBox {
  band: Band;
  capY: number;
  top: number;
  h: number;
  caption: string;
}
const boxes = computed<BandBox[]>(() => {
  let y = 0;
  return visibleBands.value.map((b) => {
    const h = bandPreview.value?.id === b.id ? bandPreview.value.h : b.height;
    const bx = { band: b, capY: y, top: y + CAP, h, caption: bandCaption(state.report, b) };
    y += CAP + h;
    return bx;
  });
});
const totalH = computed(() => {
  const l = boxes.value[boxes.value.length - 1];
  return l ? l.top + l.h + 1 : 100;
});
const canvasW = computed(() => pg.value.width * z.value + PAD * 2);
const canvasH = computed(() => totalH.value * z.value + PAD * 2);
const elementsByBand = computed(() => {
  const m: Record<string, ReportElement[]> = {};
  for (const e of state.report.elements) (m[e.bandId] ??= []).push(e);
  return m;
});
const boxOf = (bandId: string) => boxes.value.find((b) => b.band.id === bandId);
const visibleBandIds = computed(() => new Set(boxes.value.map((b) => b.band.id)));
const selSet = computed(() => new Set(state.selection));

function gridStyle(b: Band) {
  const s: Record<string, string> = {};
  if (b.backColor) s.backgroundColor = b.backColor;
  if (state.showGrid) {
    const g = state.gridSize * (state.gridSize < 6 ? 2 : 1);
    s.backgroundImage = 'radial-gradient(circle, #b8c3d1 0.9px, transparent 1.1px)';
    s.backgroundSize = `${g}px ${g}px`;
    s.backgroundPosition = `${ml.value - g / 2}px ${-g / 2}px`;
  }
  return s;
}
function bandTags(b: Band) {
  const t: string[] = [];
  if (!b.visible) t.push('hidden');
  if (b.visibleExpr) t.push('conditional');
  if (b.keepTogether) t.push('keep together');
  if (b.pageBreakBefore) t.push('break before');
  if (b.pageBreakAfter) t.push('break after');
  if (b.repeatEveryPage) t.push('repeat');
  if (b.evenRowColor) t.push('odd/even');
  return t;
}

// ------------------------------------------------------------------ geometry helpers
type Pt = { x: number; y: number };
function toPage(e: MouseEvent | DragEvent): Pt {
  const r = pageEl.value!.getBoundingClientRect();
  return { x: (e.clientX - r.left) / z.value, y: (e.clientY - r.top) / z.value };
}
function bandAt(y: number): BandBox | undefined {
  const bs = boxes.value;
  if (!bs.length) return undefined;
  for (const b of bs) if (y >= b.capY && y < b.top + b.h) return b;
  return y < bs[0].capY ? bs[0] : bs[bs.length - 1];
}
const snap = (v: number, on = state.snapToGrid) => (on ? Math.round(v / state.gridSize) * state.gridSize : Math.round(v));
function absRect(el: ReportElement) {
  const b = boxOf(el.bandId);
  return { x: ml.value + el.x, y: (b?.top ?? 0) + el.y, w: el.width, h: el.height };
}

// ------------------------------------------------------------------ drag state
interface Item {
  id: string;
  bandId: string;
  absX: number;
  absY: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
type Drag =
  | { kind: 'move'; start: Pt; items: Item[]; moved: boolean; primary: string; dx: number; dy: number; target: string | null; selectOnly: string | null; xs: number[]; ys: number[] }
  | { kind: 'resize'; start: Pt; handle: string; items: Item[]; primary: string; dx: number; dy: number }
  | { kind: 'marquee'; start: Pt; cur: Pt; additive: boolean; bandId: string }
  | { kind: 'band'; bandId: string; startY: number; startH: number; minH: number }
  | { kind: 'cells'; id: string }
  | { kind: 'tableBorder'; id: string; axis: 'col' | 'row'; index: number; start: Pt; orig: number[]; base: number; snapTo: number[]; neighbor: boolean; key: string }
  /** a column dragged by its grip above the table; `to` = the gap it goes to (null = stays) */
  | { kind: 'colMove'; id: string; from: number; start: Pt; x: number; moved: boolean; to: number | null; blocked: boolean }
  /** a line of a cross tab: `k` row headers / cells / rows lie before it, so they share the distance moved */
  | { kind: 'ctBorder'; id: string; axis: 'col' | 'row'; prop: CtSizeProp; k: number; start: Pt; orig: number; key: string };
type CtSizeProp = 'rowHeaderWidth' | 'cellWidth' | 'rowHeight';
const drag = ref<Drag | null>(null);
/** table column / row border under the mouse (cursor col-resize / row-resize) */
const borderHover = ref<'col' | 'row' | null>(null);
const guides = ref<{ x: number | null; y: number | null }>({ x: null, y: null });

function itemsFromSelection(): Item[] {
  return selectedElements.value
    .filter((e) => !e.locked)
    .map((e) => {
      const a = absRect(e);
      return { id: e.id, bandId: e.bandId, absX: a.x, absY: a.y, x: e.x, y: e.y, w: e.width, h: e.height };
    });
}

const ghosts = computed(() => {
  const d = drag.value;
  if (!d) return [];
  if (d.kind === 'move' && d.moved) return d.items.map((i) => ({ x: i.absX + d.dx, y: i.absY + d.dy, w: i.w, h: i.h }));
  if (d.kind === 'resize') return d.items.map((i) => resized(i, d.handle, d.dx, d.dy)).map((r, k) => ({ x: r.x + (d.items[k].absX - d.items[k].x), y: r.y + (d.items[k].absY - d.items[k].y), w: r.w, h: r.h }));
  return [];
});
const draggingIds = computed(() => (drag.value?.kind === 'move' && drag.value.moved ? new Set(drag.value.items.map((i) => i.id)) : new Set<string>()));

function resized(i: Item, handle: string, dx: number, dy: number) {
  let { x, y, w, h } = i;
  if (handle.includes('e')) w += dx;
  if (handle.includes('w')) {
    x += dx;
    w -= dx;
  }
  if (handle.includes('s')) h += dy;
  if (handle.includes('n')) {
    y += dy;
    h -= dy;
  }
  if (w < 2) {
    if (handle.includes('w')) x -= 2 - w;
    w = 2;
  }
  if (h < 2) {
    if (handle.includes('n')) y -= 2 - h;
    h = 2;
  }
  return { x, y, w, h };
}

function startWindowDrag() {
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
function stopWindowDrag() {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
}
onBeforeUnmount(stopWindowDrag);

// ------------------------------------------------------------------ mouse down
function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  if (inlineEdit.value) commitInline();
  // clicking the page returns keyboard focus to the designer (so Delete, Ctrl+Z, arrows work)
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && !pageEl.value?.contains(active)) active.blur();
  const t = e.target as HTMLElement;
  const p = toPage(e);
  // a column grip above the selected table: drag it to move the column, click it to select the column
  const grip = t.closest<HTMLElement>('[data-col-grip]');
  if (grip) {
    const el = findElement(grip.dataset.table ?? '');
    if (el?.type === 'table' && !el.locked) {
      drag.value = { kind: 'colMove', id: el.id, from: Number(grip.dataset.colGrip), start: p, x: p.x, moved: false, to: null, blocked: false };
      startWindowDrag();
    }
    e.preventDefault();
    return;
  }
  // priority: a control's resize handle, then a table column / row border, then a band's bottom edge
  const hd = t.closest<HTMLElement>('[data-handle]');
  if (hd) {
    const items = itemsFromSelection();
    if (items.length) {
      drag.value = { kind: 'resize', start: p, handle: hd.dataset.handle!, items, primary: hd.dataset.owner!, dx: 0, dy: 0 };
      startWindowDrag();
    }
    e.preventDefault();
    return;
  }
  // a table column / row border: drag to change the width / height
  const border = !e.altKey && !state.formatBrush && !state.tool ? tableBorderAt(p) : null;
  if (border) {
    startBorderDrag(border, p, e.shiftKey);
    e.preventDefault();
    return;
  }
  // a line of a cross tab: drag to make the row header / the cells wider or the rows taller
  const ctb = !e.altKey && !state.formatBrush && !state.tool ? crosstabBorderAt(p) : null;
  if (ctb) {
    if (state.selection.length !== 1 || state.selection[0] !== ctb.el.id) select([ctb.el.id]);
    drag.value = { kind: 'ctBorder', id: ctb.el.id, axis: ctb.axis, prop: ctb.prop, k: ctb.k, start: p, orig: ctb.el[ctb.prop], key: 'ctborder:' + ctb.el.id + ':' + Date.now() };
    startWindowDrag();
    e.preventDefault();
    return;
  }
  const rz = t.closest<HTMLElement>('[data-band-resize]');
  if (rz) {
    const id = rz.dataset.bandResize!;
    const b = boxOf(id)!;
    const minH = Math.max(0, ...(elementsByBand.value[id] ?? []).map((x) => x.y + x.height));
    drag.value = { kind: 'band', bandId: id, startY: p.y, startH: b.h, minH };
    bandPreview.value = { id, h: b.h };
    startWindowDrag();
    e.preventDefault();
    return;
  }
  const cap = t.closest<HTMLElement>('[data-band-cap]');
  if (cap) {
    selectBand(cap.dataset.bandCap!);
    return;
  }
  if (state.tool) {
    placeTool(state.tool, p, e.shiftKey);
    e.preventDefault();
    return;
  }
  const elDiv = t.closest<HTMLElement>('[data-el-id]');
  if (state.formatBrush) {
    // Format Painter: apply the copied formatting to the clicked control / table cell
    const el = elDiv ? findElement(elDiv.dataset.elId!) : null;
    if (el && !el.locked) {
      applyFormatBrush(el.id, el.type === 'table' ? cellAt(el, p) : null);
      select([el.id]);
    } else state.formatBrush = null;
    e.preventDefault();
    return;
  }
  if (elDiv) {
    const id = elDiv.dataset.elId!;
    const el = findElement(id);
    if (!el) return;
    // working inside a table (a cell is selected): Shift+click extends the cell range, dragging selects cells
    if (el.type === 'table' && !el.locked && state.selection.length === 1 && state.selection[0] === id && state.selectedCell?.id === id) {
      const c = cellAt(el, p);
      if (e.shiftKey) state.selectedCell = { ...state.selectedCell, row2: c.row, col2: c.col };
      else {
        state.selectedCell = { id, ...c };
        drag.value = { kind: 'cells', id };
        startWindowDrag();
      }
      e.preventDefault();
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
      select([id], true);
      return;
    }
    let selectOnly: string | null = null;
    if (el.type === 'table' && state.selection.length === 1 && state.selection[0] === id) {
      pickCell(el as TableElement, p);
    } else if (el.type === 'crosstab') {
      // a cross tab: the click selects it and its Rows / Columns / Data area at once (double-click = choose a field)
      if (state.selection.length !== 1 || state.selection[0] !== id) select([id]);
      const zn = crosstabZoneAt(el, p);
      ctSel.value = zn ? { id, zone: zn.zone } : null;
    } else if (!state.selection.includes(id)) select([id]);
    else if (state.selection.length > 1) selectOnly = id;
    else state.selectedCell = null;
    const items = itemsFromSelection();
    if (!items.length) return;
    const others = state.report.elements.filter((x) => !selSet.value.has(x.id));
    const xs = [ml.value, ml.value + cw.value];
    const ys: number[] = [];
    for (const o of others) {
      const a = absRect(o);
      xs.push(a.x, a.x + a.w, a.x + a.w / 2);
      ys.push(a.y, a.y + a.h, a.y + a.h / 2);
    }
    drag.value = { kind: 'move', start: p, items, moved: false, primary: id, dx: 0, dy: 0, target: null, selectOnly, xs, ys };
    startWindowDrag();
    e.preventDefault();
    return;
  }
  const body = t.closest<HTMLElement>('[data-band-id]');
  if (body) {
    drag.value = { kind: 'marquee', start: p, cur: p, additive: e.shiftKey || e.ctrlKey, bandId: body.dataset.bandId! };
    startWindowDrag();
    e.preventDefault();
  }
}

/**
 * Column / row border of a table under a page point. Inner borders and the right / bottom edge count;
 * a border hidden inside a merged cell does not.
 */
function tableBorderAt(p: Pt): { el: TableElement; axis: 'col' | 'row'; index: number } | null {
  const tol = 4 / z.value;
  const els = state.report.elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.type !== 'table' || el.locked || !visibleBandIds.value.has(el.bandId)) continue;
    const a = absRect(el);
    if (p.x < a.x - tol || p.x > a.x + a.w + tol || p.y < a.y - tol || p.y > a.y + a.h + tol) continue;
    const g = gridAt(el, p);
    const owners = cellOwners(el);
    let x = a.x;
    for (let c = 0; c < el.columns.length; c++) {
      x += el.columns[c];
      if (Math.abs(p.x - x) > tol) continue;
      if (c < el.columns.length - 1) {
        const l = owners[g.row][c];
        const r = owners[g.row][c + 1];
        if (l.row === r.row && l.col === r.col) continue; // inside a merged cell
      }
      return { el, axis: 'col', index: c };
    }
    let y = a.y;
    for (let r = 0; r < el.rows.length; r++) {
      y += el.rows[r].height;
      if (Math.abs(p.y - y) > tol) continue;
      if (r < el.rows.length - 1) {
        const u = owners[r][g.col];
        const d = owners[r + 1][g.col];
        if (u.row === d.row && u.col === d.col) continue;
      }
      return { el, axis: 'row', index: r };
    }
    if (p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h) return null; // top-most table, not on a border
  }
  return null;
}
/**
 * A line of a cross tab under a page point: the row header's right line (its width), the cell lines incl. the right
 * edge (the cell width) and the row lines incl. the bottom edge (the row height).
 */
function crosstabBorderAt(p: Pt): { el: CrosstabElement; axis: 'col' | 'row'; prop: CtSizeProp; k: number } | null {
  const tol = 4 / z.value;
  const els = state.report.elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.type !== 'crosstab' || el.locked || !visibleBandIds.value.has(el.bandId)) continue;
    const a = absRect(el);
    if (p.x < a.x - tol || p.x > a.x + a.w + tol || p.y < a.y - tol || p.y > a.y + a.h + tol) continue;
    const { cols, rows } = crosstabSize(el);
    if (Math.abs(p.x - (a.x + el.rowHeaderWidth)) <= tol) return { el, axis: 'col', prop: 'rowHeaderWidth', k: 1 };
    for (let k = 1; k <= cols; k++) if (Math.abs(p.x - (a.x + el.rowHeaderWidth + k * el.cellWidth)) <= tol) return { el, axis: 'col', prop: 'cellWidth', k };
    for (let k = 1; k <= rows; k++) if (Math.abs(p.y - (a.y + k * el.rowHeight)) <= tol) return { el, axis: 'row', prop: 'rowHeight', k };
    return null;
  }
  return null;
}

/** Start dragging a table column / row border. */
function startBorderDrag(tb: { el: TableElement; axis: 'col' | 'row'; index: number }, p: Pt, shift: boolean) {
  const el = tb.el;
  const a = absRect(el);
  if (!state.selection.includes(el.id) || state.selection.length !== 1) select([el.id]);
  const orig = tb.axis === 'col' ? [...el.columns] : el.rows.map((r) => r.height);
  const base = (tb.axis === 'col' ? a.x : a.y) + orig.slice(0, tb.index + 1).reduce((s, v) => s + v, 0);
  // column borders snap to the column lines of other tables and the edges of other controls
  const snapTo: number[] = [];
  if (tb.axis === 'col')
    for (const o of state.report.elements) {
      if (o.id === el.id || !visibleBandIds.value.has(o.bandId)) continue;
      const r = absRect(o);
      snapTo.push(r.x, r.x + r.w);
      if (o.type === 'table') {
        let x = r.x;
        for (const w of o.columns) snapTo.push((x += w));
      }
    }
  drag.value = {
    kind: 'tableBorder',
    id: el.id,
    axis: tb.axis,
    index: tb.index,
    start: p,
    orig,
    base,
    snapTo,
    // inner column border: the column to the right gives / takes the width (table keeps its width); Shift = only this column
    neighbor: tb.axis === 'col' && tb.index < el.columns.length - 1 && !shift,
    key: 'border:' + el.id + ':' + Date.now(),
  };
  startWindowDrag();
}

/** Grid position under a page point (not resolved to merged cells). */
function gridAt(el: TableElement, p: Pt) {
  const a = absRect(el);
  let col = el.columns.length - 1;
  for (let i = 0, x = a.x; i < el.columns.length; x += el.columns[i], i++) {
    if (p.x < x + el.columns[i]) {
      col = Math.max(0, i);
      break;
    }
  }
  let row = el.rows.length - 1;
  for (let i = 0, y = a.y; i < el.rows.length; y += el.rows[i].height, i++) {
    if (p.y < y + el.rows[i].height) {
      row = Math.max(0, i);
      break;
    }
  }
  return { row, col };
}
/** Table cell under a page point (a merged cell answers with its top-left position). */
function cellAt(el: TableElement, p: Pt) {
  const g = gridAt(el, p);
  return ownerOf(el, g.row, g.col);
}
function cellBox(el: TableElement, row: number, col: number) {
  const a = absRect(el);
  const r = cellRectOf(el, row, col);
  return { x: a.x + r.x, y: a.y + r.y, w: r.w, h: r.h };
}
function pickCell(el: TableElement, p: Pt) {
  state.selectedCell = { id: el.id, ...cellAt(el, p) };
}

// ------------------------------------------------------------------ cross tab (pivot table) areas
type CtArea = CrosstabZone | 'corner';
/** the clicked area of the selected cross tab (highlighted like a table cell) */
const ctSel = ref<{ id: string; zone: CtArea } | null>(null);
/** Rows / Columns / Data / corner area of a cross tab as drawn in the designer (page coordinates) */
function crosstabZoneRect(el: CrosstabElement, zone: CtArea) {
  const a = absRect(el);
  const left = zone === 'corner' || zone === 'row';
  const top = zone === 'corner' || zone === 'column';
  return { x: a.x + (left ? 0 : el.rowHeaderWidth), y: a.y + (top ? 0 : el.rowHeight), w: left ? el.rowHeaderWidth : el.cellWidth * 2, h: el.rowHeight };
}
function crosstabZoneAt(el: CrosstabElement, p: Pt): { zone: CtArea; rect: ReturnType<typeof crosstabZoneRect> } | null {
  const a = absRect(el);
  const x = p.x - a.x;
  const y = p.y - a.y;
  if (x < 0 || y < 0 || y >= el.rowHeight * 2 || x >= el.rowHeaderWidth + el.cellWidth * 2) return null;
  const zone: CtArea = y < el.rowHeight ? (x < el.rowHeaderWidth ? 'corner' : 'column') : x < el.rowHeaderWidth ? 'row' : 'value';
  return { zone, rect: crosstabZoneRect(el, zone) };
}
const ctRect = computed(() => {
  const s = ctSel.value;
  if (!s || state.selection.length !== 1 || state.selection[0] !== s.id) return null;
  const el = findElement(s.id);
  return el?.type === 'crosstab' ? crosstabZoneRect(el, s.zone) : null;
});

/** Top-most label, table cell or cross tab area under a point — the target when a field is dropped onto the page. */
function bindTargetAt(p: Pt): { el: ReportElement; cell: { row: number; col: number } | null; zone?: CrosstabZone; rect: { x: number; y: number; w: number; h: number } } | null {
  for (let i = state.report.elements.length - 1; i >= 0; i--) {
    const el = state.report.elements[i];
    if (el.locked || (el.type !== 'text' && el.type !== 'table' && el.type !== 'crosstab')) continue;
    const a = absRect(el);
    if (p.x < a.x || p.x > a.x + a.w || p.y < a.y || p.y > a.y + a.h) continue;
    if (el.type === 'table') {
      const c = cellAt(el, p);
      return { el, cell: c, rect: cellBox(el, c.row, c.col) };
    }
    if (el.type === 'crosstab') {
      const zn = crosstabZoneAt(el, p);
      return zn && zn.zone !== 'corner' ? { el, cell: null, zone: zn.zone, rect: zn.rect } : null;
    }
    return { el, cell: null, rect: a };
  }
  return null;
}

// ------------------------------------------------------------------ mouse move / up
function onMove(e: MouseEvent) {
  const d = drag.value;
  if (!d) return;
  const p = toPage(e);
  if (d.kind === 'band') {
    let h = d.startH + (p.y - d.startY);
    h = Math.max(d.minH, state.snapToGrid && !e.altKey ? snap(h) : Math.round(h));
    bandPreview.value = { id: d.bandId, h: Math.max(0, h) };
    return;
  }
  if (d.kind === 'marquee') {
    d.cur = p;
    return;
  }
  if (d.kind === 'cells') {
    const el = findElement(d.id);
    const sc = state.selectedCell;
    if (el?.type === 'table' && sc?.id === d.id) {
      const g = gridAt(el, p);
      if (g.row !== (sc.row2 ?? sc.row) || g.col !== (sc.col2 ?? sc.col)) state.selectedCell = { ...sc, row2: g.row, col2: g.col };
    }
    return;
  }
  if (d.kind === 'ctBorder') {
    const v = Math.max(d.prop === 'rowHeight' ? 12 : 20, Math.round(d.orig + (d.axis === 'col' ? p.x - d.start.x : p.y - d.start.y) / d.k));
    mutateLive(d.key, (r) => {
      const t = r.elements.find((x) => x.id === d.id);
      if (!t || t.type !== 'crosstab') return;
      t[d.prop] = v;
      syncCrosstabSize(t);
      const band = r.bands.find((b) => b.id === t.bandId);
      const bottom = Math.max(0, ...r.elements.filter((x) => x.bandId === t.bandId).map((x) => x.y + x.height));
      if (band && bottom > band.height) band.height = Math.ceil(bottom);
    });
    return;
  }
  if (d.kind === 'colMove') {
    if (!d.moved && Math.abs(p.x - d.start.x) * z.value < 4) return;
    d.moved = true;
    d.x = p.x;
    const el = findElement(d.id);
    if (!el || el.type !== 'table') return;
    // the gap between columns nearest to the mouse
    const a = absRect(el);
    let best = 0;
    let bd = Infinity;
    for (let k = 0, gx = a.x; k <= el.columns.length; gx += el.columns[k] ?? 0, k++) {
      const dd = Math.abs(p.x - gx);
      if (dd < bd) {
        bd = dd;
        best = k;
      }
    }
    const stays = best === d.from || best === d.from + 1;
    const ok = !stays && !!columnMoveOrder(el, d.from, best);
    d.to = ok ? best : null;
    d.blocked = !stays && !ok;
    return;
  }
  if (d.kind === 'tableBorder') {
    const MIN = 8;
    const i = d.index;
    let pos = d.base + (d.axis === 'col' ? p.x - d.start.x : p.y - d.start.y);
    let guide: number | null = null;
    if (!e.altKey) {
      // snap a column border to other tables' column lines / control edges, otherwise to the grid
      const tol = 6 / z.value;
      const near = d.snapTo.reduce<number | null>((best, v) => (Math.abs(v - pos) <= tol && (best === null || Math.abs(v - pos) < Math.abs(best - pos)) ? v : best), null);
      if (near !== null) pos = guide = near;
      else if (d.axis === 'col') pos = ml.value + snap(pos - ml.value);
      else {
        const el = findElement(d.id);
        const top = el ? (boxOf(el.bandId)?.top ?? 0) : 0;
        pos = top + snap(pos - top);
      }
    } else pos = Math.round(pos);
    let delta = pos - d.base;
    const sizes = [...d.orig];
    if (d.neighbor) {
      delta = Math.max(MIN - sizes[i], Math.min(sizes[i + 1] - MIN, delta));
      sizes[i] += delta;
      sizes[i + 1] -= delta;
    } else sizes[i] = Math.max(MIN, sizes[i] + delta);
    guides.value = { x: d.axis === 'col' && guide !== null ? guide : null, y: null };
    mutateLive(d.key, (r) => {
      const t = r.elements.find((x) => x.id === d.id);
      if (!t || t.type !== 'table') return;
      if (d.axis === 'col') {
        t.columns = sizes.map((v) => Math.round(v));
        t.width = t.columns.reduce((a, b) => a + b, 0);
      } else {
        sizes.forEach((h, k) => t.rows[k] && (t.rows[k].height = Math.round(h)));
        t.height = t.rows.reduce((a, b) => a + b.height, 0);
        const band = r.bands.find((b) => b.id === t.bandId);
        const bottom = Math.max(0, ...r.elements.filter((x) => x.bandId === t.bandId).map((x) => x.y + x.height));
        if (band && bottom > band.height) band.height = Math.ceil(bottom);
      }
    });
    return;
  }
  let dx = p.x - d.start.x;
  let dy = p.y - d.start.y;
  const gridOn = state.snapToGrid && !e.altKey;
  if (d.kind === 'move') {
    if (!d.moved && Math.hypot(dx, dy) * z.value < 3) return;
    d.moved = true;
    const prim = d.items.find((i) => i.id === d.primary) ?? d.items[0];
    const tb = bandAt(p.y);
    d.target = tb?.band.id ?? null;
    const singleBand = d.items.every((i) => i.bandId === d.items[0].bandId);
    const refTop = singleBand && tb ? tb.top : boxOf(prim.bandId)!.top;
    if (gridOn) {
      const nx = ml.value + snap(prim.absX + dx - ml.value, true);
      const ny = refTop + snap(prim.absY + dy - refTop, true);
      dx = nx - prim.absX;
      dy = ny - prim.absY;
    }
    guides.value = { x: null, y: null };
    if (state.snapLines && !e.altKey) {
      const thr = 5 / z.value;
      const l = Math.min(...d.items.map((i) => i.absX)) + dx;
      const r = Math.max(...d.items.map((i) => i.absX + i.w)) + dx;
      const t = Math.min(...d.items.map((i) => i.absY)) + dy;
      const b = Math.max(...d.items.map((i) => i.absY + i.h)) + dy;
      let best: { d: number; adj: number; at: number } | null = null;
      for (const v of [l, (l + r) / 2, r])
        for (const c of d.xs) {
          const dd = Math.abs(c - v);
          if (dd <= thr && (!best || dd < best.d)) best = { d: dd, adj: c - v, at: c };
        }
      if (best) {
        dx += best.adj;
        guides.value.x = best.at;
      }
      let bestY: { d: number; adj: number; at: number } | null = null;
      for (const v of [t, (t + b) / 2, b])
        for (const c of d.ys) {
          const dd = Math.abs(c - v);
          if (dd <= thr && (!bestY || dd < bestY.d)) bestY = { d: dd, adj: c - v, at: c };
        }
      if (bestY) {
        dy += bestY.adj;
        guides.value.y = bestY.at;
      }
    }
    d.dx = dx;
    d.dy = dy;
    return;
  }
  if (d.kind === 'resize') {
    const prim = d.items.find((i) => i.id === d.primary) ?? d.items[0];
    if (gridOn) {
      if (d.handle.includes('e')) dx = snap(prim.x + prim.w + dx, true) - (prim.x + prim.w);
      if (d.handle.includes('w')) dx = snap(prim.x + dx, true) - prim.x;
      if (d.handle.includes('s')) dy = snap(prim.y + prim.h + dy, true) - (prim.y + prim.h);
      if (d.handle.includes('n')) dy = snap(prim.y + dy, true) - prim.y;
    }
    d.dx = dx;
    d.dy = dy;
  }
}

function onUp(e: MouseEvent) {
  stopWindowDrag();
  const d = drag.value;
  drag.value = null;
  guides.value = { x: null, y: null };
  if (!d) return;
  if (d.kind === 'tableBorder' || d.kind === 'ctBorder') {
    endLive();
    return;
  }
  if (d.kind === 'colMove') {
    const el = findElement(d.id);
    if (!el || el.type !== 'table') return;
    if (!d.moved) {
      // a click on the grip selects the whole column (then: Delete Column, formatting, Merge …)
      state.selectedCell = { id: el.id, row: 0, col: d.from, row2: el.rows.length - 1, col2: d.from };
      return;
    }
    if (d.to !== null) moveTableColumn(el.id, d.from, d.to);
    else if (d.blocked) notify('The column cannot go there: a merged cell would be split. Unmerge it first.');
    return;
  }
  if (d.kind === 'band') {
    const h = bandPreview.value?.h ?? d.startH;
    bandPreview.value = null;
    if (h !== d.startH) setBandProp(d.bandId, 'height', h);
    return;
  }
  if (d.kind === 'marquee') {
    const x0 = Math.min(d.start.x, d.cur.x);
    const y0 = Math.min(d.start.y, d.cur.y);
    const x1 = Math.max(d.start.x, d.cur.x);
    const y1 = Math.max(d.start.y, d.cur.y);
    if ((x1 - x0) * z.value < 3 && (y1 - y0) * z.value < 3) {
      if (!d.additive) selectBand(d.bandId);
      return;
    }
    const ids = state.report.elements
      .filter((el) => {
        const a = absRect(el);
        return a.x < x1 && a.x + a.w > x0 && a.y < y1 && a.y + a.h > y0;
      })
      .map((el) => el.id);
    if (d.additive) select(ids, true);
    else select(ids);
    return;
  }
  if (d.kind === 'move') {
    if (!d.moved) {
      if (d.selectOnly) select([d.selectOnly]);
      return;
    }
    const singleBand = d.items.every((i) => i.bandId === d.items[0].bandId);
    const moves = d.items.map((i) => {
      let bandId = i.bandId;
      if (singleBand && d.target && d.target !== i.bandId) bandId = d.target;
      const box = boxOf(bandId)!;
      let x = i.absX + d.dx - ml.value;
      const y = i.absY + d.dy - box.top;
      if (state.report.page.autoWidth) x = Math.max(0, x);
      else if (i.w <= cw.value) x = Math.min(Math.max(0, x), cw.value - i.w);
      return { id: i.id, x, y: Math.max(0, y), bandId };
    });
    moveElements(moves);
    return;
  }
  if (d.kind === 'resize') {
    if (!d.dx && !d.dy) return;
    resizeElements(
      d.items.map((i) => {
        const r = resized(i, d.handle, d.dx, d.dy);
        return { id: i.id, x: r.x, y: r.y, width: r.w, height: r.h };
      }),
    );
  }
}

// ------------------------------------------------------------------ tools & drop
function placeTool(tool: ToolId, p: Pt, keep = false, extra?: Partial<ReportElement>) {
  const bx = bandAt(p.y);
  if (!bx) return;
  const x = snap(p.x - ml.value);
  const y = snap(Math.max(0, p.y - bx.top));
  addElement(tool, bx.band.id, x, y, extra);
  if (!keep) state.tool = null;
}

const dropHint = ref<{ x: number; y: number; w: number; h: number; bind?: boolean } | null>(null);
function acceptDrag(e: DragEvent) {
  const types = e.dataTransfer?.types ?? [];
  return types.includes('text/x-rt-tool') || types.includes('text/x-rt-field');
}
function onDragOver(e: DragEvent) {
  if (!acceptDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  const p = toPage(e);
  // a field dragged over a label / table cell binds it (highlighted in green)
  if (e.dataTransfer?.types.includes('text/x-rt-field')) {
    const t = bindTargetAt(p);
    if (t) {
      dropHint.value = { ...t.rect, bind: true };
      return;
    }
  }
  const bx = bandAt(p.y);
  if (!bx) return;
  dropHint.value = { x: ml.value + snap(p.x - ml.value), y: bx.top + snap(Math.max(0, p.y - bx.top)), w: 120, h: 22 };
}
function onDrop(e: DragEvent) {
  dropHint.value = null;
  const dt = e.dataTransfer;
  if (!dt) return;
  const p = toPage(e);
  const tool = dt.getData('text/x-rt-tool');
  if (tool) return placeTool(tool as ToolId, p, false);
  const f = dt.getData('text/x-rt-field');
  if (f) {
    const choice = JSON.parse(f) as FieldChoice;
    const { expr, name, type, text, format, align, caption } = choice;
    const t = bindTargetAt(p);
    if (t?.zone) {
      // a field dropped on the Rows / Columns / Data area of a cross tab
      select([t.el.id]);
      ctSel.value = { id: t.el.id, zone: t.zone };
      if (text !== undefined) return notify('Use a data field here (page numbers and dates of printing cannot be summarized)');
      setCrosstabField(t.el.id, t.zone, expr, type);
      return;
    }
    if (t) {
      bindToField(t.el.id, t.cell, { expr, name, type, text, format, align, caption });
      select([t.el.id]);
      if (t.cell) state.selectedCell = { id: t.el.id, ...t.cell };
      return;
    }
    // special fields with text ("Page {PageNumber()} of {PageCount()}") become labels
    if (text !== undefined) placeTool('text', p, false, { text, style: align ? { textAlign: align } : {} } as any);
    else
      placeTool('field', p, false, {
        expression: expr,
        format: format ?? (type === 'date' ? 'd' : ''),
        style: align ? { textAlign: align } : type === 'number' ? { textAlign: 'right' } : {},
      } as any);
  }
}

// ------------------------------------------------------------------ inline editing
const inlineEdit = ref<{ id: string; cell?: { row: number; col: number }; corner?: boolean; x: number; y: number; w: number; h: number; value: string; css: Record<string, string> } | null>(null);
const inlineRef = ref<HTMLTextAreaElement>();

const cssOf = (s: ReturnType<typeof resolveStyle>) => ({
  fontFamily: s.fontFamily,
  fontSize: s.fontSize * PT + 'px',
  fontWeight: s.bold ? 'bold' : 'normal',
  fontStyle: s.italic ? 'italic' : 'normal',
  textAlign: s.textAlign,
  color: s.color,
});

/** Edit the static text of a label or a table cell in place. */
async function startInline(el: ReportElement, cell: { row: number; col: number } | null) {
  // a bound "[Field]" with no text starts with the field name, e.g. to turn it into a caption
  const initial = (text: string, expr: string) => text || (/^\[([^\]]+)\]$/.exec(expr.trim())?.[1] ?? '');
  if (cell && el.type === 'table') {
    const r = cellBox(el, cell.row, cell.col);
    const c = el.rows[cell.row].cells[cell.col];
    inlineEdit.value = {
      id: el.id,
      cell,
      x: r.x,
      y: r.y,
      w: Math.max(r.w, 60),
      h: Math.max(r.h, 24),
      value: initial(c.text, c.expression),
      css: cssOf(resolveStyle(state.report, el.styleName, el.style, c.style)),
    };
  } else if (el.type === 'text') {
    const a = absRect(el);
    inlineEdit.value = { id: el.id, x: a.x, y: a.y, w: Math.max(a.w, 60), h: Math.max(a.h, 24), value: initial(el.text, el.expression), css: cssOf(resolveStyle(state.report, el.styleName, el.style)) };
  } else return;
  await nextTick();
  inlineRef.value?.focus();
  inlineRef.value?.select();
}

// ------------------------------------------------------------------ field picker (double-click a cell / data label)
const picker = ref<{
  id: string;
  cell: { row: number; col: number } | null;
  x: number;
  y: number;
  w: number;
  current: string;
  title: string;
  dataSourceId: string | null;
  masterDataSourceId: string | null;
  /** a cross tab area instead of a label / cell (fields only, no static text) */
  zone?: CrosstabZone;
  allowText: boolean;
} | null>(null);

/** where the picker opens: below the box (above it when there is no room below) */
function pickerPlace(r: { x: number; y: number; w: number; h: number }) {
  const pr = pageEl.value!.getBoundingClientRect();
  const w = Math.max(260, Math.min(360, r.w * z.value));
  const H = 350;
  let left = pr.left + r.x * z.value;
  let top = pr.top + (r.y + r.h) * z.value + 3;
  if (top + H > window.innerHeight - 8) top = Math.max(8, pr.top + r.y * z.value - H - 3);
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  return { x: left, y: top, w };
}

/** Choose the field of a cross tab's Rows / Columns / Data area */
function openCrosstabPicker(el: CrosstabElement, zone: CrosstabZone) {
  select([el.id]);
  ctSel.value = { id: el.id, zone };
  picker.value = {
    id: el.id,
    cell: null,
    ...pickerPlace(crosstabZoneRect(el, zone)),
    current: el[CROSSTAB_PROP[zone]] ?? '',
    title: `${el.name} · ${CROSSTAB_LABEL[zone]}`,
    dataSourceId: dataSourceOfBand(el.bandId),
    masterDataSourceId: masterDataSourceOfBand(el.bandId),
    zone,
    allowText: false,
  };
}

function openPicker(el: ReportElement, cell: { row: number; col: number } | null) {
  if (el.type !== 'text' && el.type !== 'table') return;
  const r = cell && el.type === 'table' ? cellBox(el, cell.row, cell.col) : absRect(el);
  const pr = pageEl.value!.getBoundingClientRect();
  const w = Math.max(260, Math.min(360, r.w * z.value));
  const H = 350;
  let left = pr.left + r.x * z.value;
  let top = pr.top + (r.y + r.h) * z.value + 3;
  if (top + H > window.innerHeight - 8) top = Math.max(8, pr.top + r.y * z.value - H - 3);
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  const current = cell && el.type === 'table' ? el.rows[cell.row].cells[cell.col].expression : el.type === 'text' ? el.expression : '';
  picker.value = {
    id: el.id,
    cell,
    x: left,
    y: top,
    w,
    current: current ?? '',
    title: cell ? `${el.name} · row ${cell.row + 1}, column ${cell.col + 1}` : el.name,
    dataSourceId: dataSourceOfBand(el.bandId),
    masterDataSourceId: masterDataSourceOfBand(el.bandId),
    allowText: true,
  };
}
function onPick(f: FieldChoice) {
  const p = picker.value!;
  picker.value = null;
  if (p.zone) {
    if (f.text !== undefined) return notify('Use a data field here (page numbers and dates of printing cannot be summarized)');
    return setCrosstabField(p.id, p.zone, f.expr, f.type);
  }
  bindToField(p.id, p.cell, f);
}
function onPickerText() {
  const p = picker.value!;
  picker.value = null;
  const el = findElement(p.id);
  if (el) void startInline(el, p.cell);
}
async function onPickerExpression() {
  const p = picker.value!;
  picker.value = null;
  const v = await editExpression(p.current, p.zone ? `${CROSSTAB_LABEL[p.zone]} — ${findElement(p.id)?.name ?? ''}` : 'Expression');
  if (v === null) return;
  if (p.zone) setCrosstabField(p.id, p.zone, v.trim());
  else if (p.cell)
    mutate((r) => {
      const t = r.elements.find((x) => x.id === p.id) as TableElement | undefined;
      if (t) t.rows[p.cell!.row].cells[p.cell!.col].expression = v;
    });
  else setElementProp('expression', v, [p.id]);
}
function onPickerClear() {
  const p = picker.value!;
  picker.value = null;
  if (p.zone) setCrosstabField(p.id, p.zone, '');
  else clearBinding(p.id, p.cell);
}

async function onDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const elDiv = t.closest<HTMLElement>('[data-el-id]');
  if (!elDiv) {
    const cap = t.closest<HTMLElement>('[data-band-cap]');
    if (cap) state.rightTab = 'properties';
    return;
  }
  const el = findElement(elDiv.dataset.elId!);
  if (!el || el.locked) return;
  const a = absRect(el);
  if (el.type === 'text') {
    // data-bound or empty labels: choose a field; labels with static text: edit the text
    if (el.expression || !el.text.trim()) openPicker(el, null);
    else void startInline(el, null);
    return;
  } else if (el.type === 'table') {
    pickCell(el, toPage(e));
    const c = state.selectedCell!;
    const cell = el.rows[c.row].cells[c.col];
    // cells with static text (headers): edit the text; empty or field-bound cells: choose a field
    if (!cell.expression && cell.text.trim()) void startInline(el, { row: c.row, col: c.col });
    else openPicker(el, { row: c.row, col: c.col });
    return;
  } else if (el.type === 'crosstab') {
    // Rows / Columns / Data: choose a field; the corner: type its caption; elsewhere: the properties
    const zn = crosstabZoneAt(el, toPage(e));
    if (zn?.zone === 'corner') void editCrosstabCorner(el);
    else if (zn) openCrosstabPicker(el, zn.zone);
    else state.rightTab = 'properties';
    return;
  } else if (el.type === 'barcode' || el.type === 'checkbox') {
    inlineEdit.value = { id: el.id, x: a.x, y: a.y, w: Math.max(a.w, 100), h: 26, value: el.text, css: {} };
  } else if (el.type === 'image') {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => setElementProp('src', String(rd.result), [el.id]);
      rd.readAsDataURL(f);
    };
    inp.click();
    return;
  } else {
    state.rightTab = 'properties';
    return;
  }
  await nextTick();
  inlineRef.value?.focus();
  inlineRef.value?.select();
}
function commitInline() {
  const ie = inlineEdit.value;
  if (!ie) return;
  inlineEdit.value = null;
  const value = inlineRef.value?.value ?? ie.value;
  if (ie.corner) setElementProp('corner', value, [ie.id]);
  else setStaticText(ie.id, ie.cell ?? null, value);
}

/** the caption in the top-left corner of a cross tab, typed in place */
async function editCrosstabCorner(el: CrosstabElement) {
  const r = crosstabZoneRect(el, 'corner');
  ctSel.value = { id: el.id, zone: 'corner' };
  inlineEdit.value = { id: el.id, corner: true, x: r.x, y: r.y, w: Math.max(r.w, 60), h: Math.max(r.h, 24), value: el.corner, css: cssOf(resolveStyle(state.report, el.styleName, el.style, { bold: true })) };
  await nextTick();
  inlineRef.value?.focus();
  inlineRef.value?.select();
}
/** Typed text replaces any field binding of a label / table cell, so what you type is what prints. */
function setStaticText(id: string, cell: { row: number; col: number } | null, value: string) {
  mutate((r) => {
    const el = r.elements.find((x) => x.id === id);
    if (!el) return;
    if (cell && el.type === 'table') {
      const c = el.rows[cell.row]?.cells[cell.col];
      if (c) {
        c.text = value;
        c.expression = '';
        c.summaryFunc = 'none';
      }
    } else if (el.type === 'text') {
      el.text = value;
      el.expression = '';
      el.summaryFunc = 'none';
    } else if ('text' in el) (el as { text: string }).text = value; // barcode / check box caption
  });
}
function onPickerSetText(text: string) {
  const p = picker.value!;
  picker.value = null;
  setStaticText(p.id, p.cell, text);
}

// F2 or Enter on a selected label / table cell edits its text
function onEditKey(e: KeyboardEvent) {
  if ((e.key !== 'F2' && e.key !== 'Enter') || state.mode !== 'design' || state.dialog || state.exprRequest || picker.value || inlineEdit.value) return;
  const t = e.target as HTMLElement;
  if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (state.selection.length !== 1) return;
  const el = findElement(state.selection[0]);
  if (!el || el.locked) return;
  if (el.type === 'table' && state.selectedCell?.id === el.id) {
    e.preventDefault();
    void startInline(el, { row: state.selectedCell.row, col: state.selectedCell.col });
  } else if (el.type === 'crosstab' && ctSel.value?.id === el.id) {
    e.preventDefault();
    if (ctSel.value.zone === 'corner') void editCrosstabCorner(el);
    else openCrosstabPicker(el, ctSel.value.zone);
  } else if (el.type === 'text') {
    e.preventDefault();
    void startInline(el, null);
  }
}
onMounted(() => window.addEventListener('keydown', onEditKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onEditKey));

// ------------------------------------------------------------------ clipboard (system clipboard via copy / cut / paste events)
/** last mouse position over the page: band + band-relative point (where a paste lands when nothing is selected) */
const pointer = { inside: false, bandId: '', x: 0, y: 0 };
function onPointerMove(e: MouseEvent) {
  const p = toPage(e);
  const onHandle = !!(e.target as HTMLElement)?.closest?.('[data-handle], [data-col-grip]');
  const d = drag.value;
  const hb = d
    ? d.kind === 'tableBorder' || d.kind === 'ctBorder'
      ? d.axis
      : null
    : !state.tool && !e.altKey && !onHandle
      ? (tableBorderAt(p)?.axis ?? crosstabBorderAt(p)?.axis ?? null)
      : null;
  if (hb !== borderHover.value) borderHover.value = hb;
  const bx = bandAt(p.y);
  if (!bx || p.y < bx.top) return;
  pointer.inside = true;
  pointer.bandId = bx.band.id;
  pointer.x = Math.max(0, snap(p.x - ml.value));
  pointer.y = Math.max(0, snap(p.y - bx.top));
}
function pasteTarget(): PasteTarget {
  // nothing selected and the mouse is over a band: paste right there
  if (!state.selection.length && !state.selectedBandId && pointer.inside) return { bandId: pointer.bandId, at: { x: pointer.x, y: pointer.y } };
  return {};
}
function clipboardAllowed(e: Event) {
  if (state.mode !== 'design' || state.dialog || state.exprRequest || state.loginRequests.length || inlineEdit.value || picker.value) return false;
  const t = e.target as HTMLElement | null;
  if (t instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'color', 'button'].includes(t.type)) return false;
  if (t?.closest?.('textarea, select, [contenteditable="true"], .modal, .field-picker, .cp-pop')) return false;
  // let the user copy text that is selected on the page (e.g. in a panel)
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return false;
  return true;
}
function onCopy(e: ClipboardEvent) {
  if (!clipboardAllowed(e)) return;
  const p = copySelection();
  if (!p) return;
  e.clipboardData?.setData('text/plain', clipboardText(p));
  e.preventDefault();
}
function onCut(e: ClipboardEvent) {
  if (!clipboardAllowed(e)) return;
  const p = cutSelection();
  if (!p) return;
  e.clipboardData?.setData('text/plain', clipboardText(p));
  e.preventDefault();
}
function onPaste(e: ClipboardEvent) {
  if (!clipboardAllowed(e)) return;
  const dt = e.clipboardData;
  e.preventDefault();
  const target = pasteTarget();
  const img = dt ? [...dt.items].find((i) => i.kind === 'file' && i.type.startsWith('image/')) : undefined;
  const file = img?.getAsFile();
  if (file) return void pasteImage(file, target);
  const text = dt?.getData('text/plain') ?? '';
  const payload = parseClipboardText(text);
  if (payload) return pastePayload(payload, target);
  if (text.trim()) return pasteText(text, target);
  if (hasClipboard()) pasteClipboard(target.bandId, target.at);
}
onMounted(() => {
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
});
onBeforeUnmount(() => {
  document.removeEventListener('copy', onCopy);
  document.removeEventListener('cut', onCut);
  document.removeEventListener('paste', onPaste);
});
function menuCopy() {
  const p = copySelection();
  if (p) writeSystemClipboard(p);
}
function menuCut() {
  const p = cutSelection();
  if (p) writeSystemClipboard(p);
}
function onInlineKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    inlineEdit.value = null;
    e.stopPropagation();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitInline();
  }
}

// ------------------------------------------------------------------ context menu
function onContextMenu(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const elDiv = t.closest<HTMLElement>('[data-el-id]');
  // a resize handle belongs to its control (thin lines are mostly covered by their handles)
  const ownerId = t.closest<HTMLElement>('[data-handle]')?.dataset.owner;
  const p = toPage(e);
  const bx = bandAt(p.y);
  if (elDiv || (ownerId && findElement(ownerId))) {
    const id = elDiv?.dataset.elId ?? ownerId!;
    if (!state.selection.includes(id)) select([id]);
    const el = findElement(id)!;
    if (el.type === 'table' && state.selection.length === 1) {
      // right-click inside a selected cell range keeps the range (e.g. for Merge Cells)
      const sc = state.selectedCell;
      const g = gridAt(el, p);
      const rg = sc?.id === el.id ? rangeOf(el, { row: sc.row, col: sc.col }, { row: sc.row2 ?? sc.row, col: sc.col2 ?? sc.col }) : null;
      if (!rg || g.row < rg.r0 || g.row > rg.r1 || g.col < rg.c0 || g.col > rg.c1) pickCell(el, p);
    }
    const cellSel = el.type === 'table' && state.selectedCell?.id === el.id;
    const rg = cellSel ? rangeOf(el as TableElement, { row: state.selectedCell!.row, col: state.selectedCell!.col }, { row: state.selectedCell!.row2 ?? state.selectedCell!.row, col: state.selectedCell!.col2 ?? state.selectedCell!.col }) : null;
    const many = !!rg && (rg.r1 > rg.r0 || rg.c1 > rg.c0);
    const items: MenuItem[] = [
      { label: cellSel ? (many ? 'Cut Cells' : 'Cut Cell') : 'Cut', icon: Scissors, kbd: 'Ctrl+X', action: menuCut },
      { label: cellSel ? (many ? 'Copy Cells' : 'Copy Cell') : 'Copy', icon: Copy, kbd: 'Ctrl+C', action: menuCopy },
      { label: cellSel ? 'Paste into Cell' : 'Paste', icon: ClipboardPaste, kbd: 'Ctrl+V', action: () => void pasteFromSystem({ bandId: el.bandId }) },
      { label: 'Duplicate', icon: CopyPlus, kbd: 'Ctrl+D', action: duplicateSelection },
      { label: 'Copy Formatting (Format Painter)', icon: Paintbrush, action: startFormatPainter },
      { label: 'Delete', icon: Trash2, kbd: 'Del', action: deleteSelection },
      { sep: true },
    ];
    // merging first when working with table cells
    if (cellSel) {
      items.push(
        { label: 'Merge Cells', icon: TableCellsMerge, disabled: !canMergeCells(), action: mergeCells },
        { label: 'Merge with Right Cell', icon: TableCellsMerge, action: () => mergeCellWith('right') },
        { label: 'Merge with Cell Below', icon: TableCellsMerge, action: () => mergeCellWith('down') },
      );
      if (canUnmergeCells()) items.push({ label: 'Unmerge Cells', icon: TableCellsSplit, action: unmergeCells });
      const tb = el as TableElement;
      const col = state.selectedCell!.col;
      items.push({
        label: 'Rows & Columns',
        icon: Rows3,
        children: [
          { label: 'Move Column Left', icon: ArrowLeft, disabled: !columnMoveOrder(tb, col, col - 1), action: () => moveTableColumn(tb.id, col, col - 1) },
          { label: 'Move Column Right', icon: ArrowRight, disabled: !columnMoveOrder(tb, col, col + 2), action: () => moveTableColumn(tb.id, col, col + 2) },
          { sep: true },
          { label: 'Insert Row Above', action: () => tableOp('insertRowAbove') },
          { label: 'Insert Row Below', action: () => tableOp('insertRowBelow') },
          { label: 'Insert Column Left', action: () => tableOp('insertColLeft') },
          { label: 'Insert Column Right', action: () => tableOp('insertColRight') },
          { sep: true },
          { label: 'Delete Row', action: () => tableOp('deleteRow') },
          { label: 'Delete Column', action: () => tableOp('deleteCol') },
        ],
      });
      items.push({ sep: true });
    }
    if (el.type === 'table') {
      const otherTables = state.report.elements.filter((x) => x.type === 'table' && x.id !== el.id).length;
      const sel = selectedElements.value.filter((x) => x.type === 'table').length;
      items.push({
        label: 'Column Widths',
        icon: Columns3,
        children: [
          { label: many ? 'Equal Widths (selected columns)' : 'Equal Widths (all columns)', action: () => equalizeColumns(el.id) },
          {
            label: sel > 1 ? `Match Selected Tables to This One` : 'Match Other Tables to This One',
            disabled: !otherTables,
            action: () => matchTableColumns(el.id),
          },
          { label: 'Fit to Page Width', action: () => fitTableToPageWidth(el.id) },
        ],
      });
    }
    if (el.type === 'crosstab') {
      const zn = crosstabZoneAt(el, p);
      if (zn) ctSel.value = { id: el.id, zone: zn.zone };
      const field = (zone: CrosstabZone) => {
        const cur = el[CROSSTAB_PROP[zone]];
        return { label: `${CROSSTAB_LABEL[zone]} Field…${cur ? '  ' + cur : ''}`, icon: Database, action: () => openCrosstabPicker(el, zone) };
      };
      const fns: [SummaryFunc, string][] = [
        ['sum', 'Sum'],
        ['count', 'Count'],
        ['avg', 'Average'],
        ['min', 'Minimum'],
        ['max', 'Maximum'],
        ['countDistinct', 'Distinct Count'],
      ];
      items.push(
        field('row'),
        field('column'),
        field('value'),
        { label: 'Summary of the Data', icon: Sigma, children: fns.map(([fn, label]) => ({ label, checked: el.aggregate === fn, action: () => setElementProp('aggregate', fn, [el.id]) })) },
        {
          label: 'Totals',
          icon: Table2,
          children: [
            { label: 'Row Totals (right column)', checked: el.showRowTotals, action: () => setElementProp('showRowTotals', !el.showRowTotals, [el.id]) },
            { label: 'Grand Total Row (bottom)', checked: el.showColumnTotals, action: () => setElementProp('showColumnTotals', !el.showColumnTotals, [el.id]) },
          ],
        },
        { label: 'Corner Text…', icon: Pencil, action: () => void editCrosstabCorner(el) },
        { sep: true },
      );
    }
    if (el.type === 'text' || (el.type === 'table' && state.selectedCell)) {
      const cellPos = el.type === 'table' && state.selectedCell ? { row: state.selectedCell.row, col: state.selectedCell.col } : null;
      items.push({ label: 'Bind to Field…', icon: Database, action: () => openPicker(el, cellPos) });
      const bt = state.report.bands.find((b) => b.id === el.bandId)?.type;
      if (bt === 'detail' || bt === 'drDetail') {
        const rowNo = specialFields(state.report)[0];
        items.push({ label: 'Row No. (1, 2, 3 …)', icon: Hash, action: () => bindToField(el.id, cellPos, rowNo) });
      }
    }
    if (el.type === 'text')
      items.push({
        label: 'Edit Expression…',
        icon: Pencil,
        action: async () => {
          const v = await editExpression(el.expression, `Expression — ${el.name}`);
          if (v !== null) setElementProp('expression', v, [el.id]);
        },
      });
    if (el.type === 'table' && el.rows.length > 1) {
      const band = state.report.bands.find((b) => b.id === el.bandId);
      if (band && band.type !== 'pageHeader') {
        const moves: MenuItem[] = [];
        if (band.type === 'drDetail') moves.push({ label: 'to Section Header', action: () => moveTableHeaderRow(el.id, 'section') });
        moves.push({ label: 'to Page Header', action: () => moveTableHeaderRow(el.id, 'pageHeader') });
        const lastGroup = state.report.groups[state.report.groups.length - 1];
        const gh = lastGroup && state.report.bands.find((b) => b.type === 'groupHeader' && b.groupId === lastGroup.id);
        if (gh && band.type === 'detail') moves.push({ label: 'to Group Header', action: () => moveTableHeaderRow(el.id, gh.id) });
        items.push({ label: 'Move Header Row', icon: Rows3, children: moves });
      }
    }
    // totals: from a Detail row -> footer band; in a header / footer band -> Sum in place
    const targets = el.type === 'table' || el.type === 'text' ? totalTargets(el.bandId) : [];
    if (targets.length) {
      items.push(...targets.map((t) => ({ label: 'Add ' + t.label, icon: Sigma, action: () => addTotals(t) })));
    } else if (inSummaryBand(el)) {
      items.push({ label: el.type === 'table' ? 'Make Total Row (Sum the numbers)' : 'Make Total (Sum)', icon: Sigma, action: () => convertToTotals() });
      const cur = selectedSummary();
      const sc = state.selectedCell;
      const hasExpr = el.type === 'text' ? !!el.expression.trim() : el.type === 'table' && !!sc && !!el.rows[sc.row]?.cells[sc.col]?.expression.trim();
      if (cur !== null && hasExpr) {
        const opts: [SummaryFunc, string][] = [
          ['sum', 'Sum'],
          ['count', 'Count'],
          ['avg', 'Average'],
          ['min', 'Minimum'],
          ['max', 'Maximum'],
          ['none', 'No summary (value)'],
        ];
        items.push({ label: 'Summary', icon: Sigma, children: opts.map(([fn, label]) => ({ label, checked: cur === fn, action: () => setSummary(fn) })) });
      }
    }
    if (el.type === 'line' || el.type === 'shape') {
      const cur = el.lineStyle;
      items.push({
        label: 'Line Style',
        icon: Minus,
        children: (
          [
            ['solid', 'Solid ─────'],
            ['dashed', 'Dashed – – – –'],
            ['dotted', 'Dotted · · · · ·'],
          ] as const
        ).map(([v, label]) => ({ label, checked: cur === v, action: () => applyLineStyle(v) })),
      });
    }
    items.push(
      { sep: true },
      {
        label: 'Arrange',
        icon: BringToFront,
        children: [
          { label: 'Bring to Front', icon: BringToFront, action: () => zOrder(true) },
          { label: 'Send to Back', icon: SendToBack, action: () => zOrder(false) },
        ],
      },
      { label: 'Format Rules…', icon: Settings, action: () => openDialog('formatRules'), disabled: state.selection.length !== 1 },
      { label: el.locked ? 'Unlock' : 'Lock', icon: el.locked ? LockOpen : Lock, action: () => setElementProp('locked', !el.locked) },
      { label: 'Properties', action: () => (state.rightTab = 'properties') },
    );
    openContextMenu(e, items);
    return;
  }
  if (!bx) return;
  bandMenu(e, bx.band, p);
}
function newSection(parentId: string | null, printMode: 'once' | 'perRow') {
  if (!state.report.dataSources.length) {
    openDialog('dataSources');
    return;
  }
  openDialog('detailReports', { id: addDetailReport({ parentId, printMode }) });
}
/** "Page 1 of N" at the right of a band (below the existing controls when that place is taken). */
function insertPageNumber(bandId: string) {
  const band = state.report.bands.find((b) => b.id === bandId);
  if (!band) return;
  const w = 160;
  const h = 20;
  const x = Math.max(0, Math.floor(cw.value - w));
  let y = Math.max(0, Math.round((band.height - h) / 2));
  const others = state.report.elements.filter((el) => el.bandId === bandId);
  const hits = (yy: number) => others.some((o) => o.x < x + w && o.x + o.width > x && o.y < yy + h && o.y + o.height > yy);
  if (hits(y)) y = Math.ceil(Math.max(...others.map((o) => o.y + o.height))) + 2;
  const el = addElement('pageNofM', bandId, x, y, { width: w, height: h, style: { textAlign: 'right' } } as Partial<ReportElement>);
  select([el.id]);
  notify('Page number added — it shows "Page 1 of N" on every page', 'success');
}
function bandMenu(e: MouseEvent, band: Band, p?: Pt) {
  selectBand(band.id);
  const has = (t: Band['type']) => state.report.bands.some((b) => b.type === t);
  const drId = band.detailReportId;
  const drHas = (t: 'drHeader' | 'drFooter') => state.report.bands.some((b) => b.type === t && b.detailReportId === drId);
  const items: MenuItem[] = [
    {
      label: 'Paste Here',
      icon: ClipboardPaste,
      kbd: 'Ctrl+V',
      action: () => {
        const bx = boxOf(band.id);
        const at = p && bx ? { x: Math.max(0, snap(p.x - ml.value)), y: Math.max(0, snap(p.y - bx.top)) } : undefined;
        void pasteFromSystem({ bandId: band.id, at });
      },
    },
    ...(band.type === 'pageHeader' || band.type === 'pageFooter' || band.type === 'reportHeader' || band.type === 'reportFooter'
      ? [{ label: 'Insert Page Number (Page 1 of N)', icon: Hash, action: () => insertPageNumber(band.id) }]
      : []),
    { label: 'Fit Band to Content', icon: Shrink, action: () => fitBandToContent(band.id) },
    { label: band.visible ? 'Hide Band' : 'Show Band', action: () => setBandProp(band.id, 'visible', !band.visible) },
    { sep: true },
  ];
  if (drId) {
    items.push(
      { header: 'This section' },
      { label: 'Section Settings… (data, link, filter, sort)', icon: Layers, action: () => openDialog('detailReports', { id: drId }) },
      { label: drHas('drHeader') ? 'Remove Section Header' : 'Add Section Header', icon: Rows3, action: () => toggleDetailReportBand(drId, 'drHeader') },
      { label: drHas('drFooter') ? 'Remove Section Footer' : 'Add Section Footer', icon: Rows3, action: () => toggleDetailReportBand(drId, 'drFooter') },
      { label: 'Add Nested Section (per row)…', icon: Layers, action: () => newSection(drId, 'perRow') },
      { sep: true },
    );
  }
  items.push(
    { header: 'Insert Band' },
    { label: 'Report Header', icon: Rows3, disabled: has('reportHeader'), action: () => addBand('reportHeader') },
    { label: 'Page Header', icon: Rows3, disabled: has('pageHeader'), action: () => addBand('pageHeader') },
    { label: 'Group Header / Footer…', icon: Rows3, action: () => openDialog('groupSort') },
    { label: 'Detail Report — another list (once)…', icon: Layers, action: () => newSection(null, 'once') },
    { label: 'Detail Report — per main row (master–detail)…', icon: Layers, action: () => newSection(null, 'perRow') },
    { label: 'Report Footer', icon: Rows3, disabled: has('reportFooter'), action: () => addBand('reportFooter') },
    { label: 'Page Footer', icon: Rows3, disabled: has('pageFooter'), action: () => addBand('pageFooter') },
    { sep: true },
    { label: band.type === 'drDetail' ? 'Delete Section' : 'Delete Band', icon: Trash2, disabled: band.type === 'detail', action: () => removeBand(band.id) },
  );
  openContextMenu(e, items);
  void p;
}

// ------------------------------------------------------------------ overlays
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const handles = computed(() => {
  if (drag.value && drag.value.kind !== 'marquee') return [];
  const hs = 7 / z.value;
  const out: { key: string; owner: string; h: string; x: number; y: number; s: number; primary: boolean }[] = [];
  const last = state.selection[state.selection.length - 1];
  for (const el of selectedElements.value) {
    if (el.locked) continue;
    const a = absRect(el);
    for (const h of HANDLES) {
      const x = h.includes('w') ? a.x : h.includes('e') ? a.x + a.w : a.x + a.w / 2;
      const y = h.includes('n') ? a.y : h.includes('s') ? a.y + a.h : a.y + a.h / 2;
      out.push({ key: el.id + h, owner: el.id, h, x: x - hs / 2, y: y - hs / 2, s: hs, primary: el.id === last });
    }
  }
  return out;
});
const marqueeRect = computed(() => {
  const d = drag.value;
  if (!d || d.kind !== 'marquee') return null;
  return { x: Math.min(d.start.x, d.cur.x), y: Math.min(d.start.y, d.cur.y), w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y) };
});
/** highlight of the selected cell / cell range (merged cells included) */
const cellRect = computed(() => {
  const c = state.selectedCell;
  if (!c) return null;
  const el = findElement(c.id) as TableElement | undefined;
  if (!el || el.type !== 'table') return null;
  const a = absRect(el);
  const rg = rangeOf(el, { row: c.row, col: c.col }, { row: c.row2 ?? c.row, col: c.col2 ?? c.col });
  const sum = (v: number[], from: number, to: number) => v.slice(from, to).reduce((s, x) => s + x, 0);
  const hs = el.rows.map((r) => r.height);
  return {
    x: a.x + sum(el.columns, 0, rg.c0),
    y: a.y + sum(hs, 0, rg.r0),
    w: sum(el.columns, rg.c0, rg.c1 + 1),
    h: sum(hs, rg.r0, rg.r1 + 1),
    multi: rg.r1 > rg.r0 || rg.c1 > rg.c0,
  };
});

/** grips above the selected table, one per column: drag one sideways to move that column, click it to select it */
const GRIP = 14;
const colGrips = computed(() => {
  const d = drag.value;
  if (state.selection.length !== 1 || state.tool || inlineEdit.value || (d && d.kind !== 'colMove')) return [];
  const el = findElement(state.selection[0]);
  if (!el || el.type !== 'table' || el.locked || el.columns.length < 2) return [];
  const a = absRect(el);
  const h = GRIP / z.value;
  let x = a.x;
  return el.columns.map((w, col) => {
    const g = { table: el.id, col, x, y: a.y - h - 1 / z.value, w, h, active: d?.kind === 'colMove' && d.from === col };
    x += w;
    return g;
  });
});
/** while a column is dragged: the column following the mouse and the line where it will go (in every lined-up table) */
const colMoveMarks = computed(() => {
  const d = drag.value;
  if (!d || d.kind !== 'colMove' || !d.moved) return null;
  const el = findElement(d.id);
  if (!el || el.type !== 'table') return null;
  const a = absRect(el);
  const left = a.x + el.columns.slice(0, d.from).reduce((s, v) => s + v, 0);
  const ghost = { x: left + (d.x - d.start.x), y: a.y, w: el.columns[d.from], h: a.h };
  const lines =
    d.to === null
      ? []
      : [el, ...linkedTables(el)].map((t) => {
          const r = absRect(t);
          const gx = r.x + t.columns.slice(0, d.to!).reduce((s, v) => s + v, 0);
          return { x: gx - 1.5 / z.value, y: r.y - 3 / z.value, w: 3 / z.value, h: r.h + 6 / z.value };
        });
  return { ghost, lines, blocked: d.blocked };
});

function onWheel(e: WheelEvent) {
  if (!e.ctrlKey) return;
  picker.value = null;
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.zoom = Math.min(4, Math.max(0.25, Math.round(state.zoom * f * 100) / 100));
}

// ------------------------------------------------------------------ rulers
const unitPx = computed(() => (state.rulerUnit === 'cm' ? 96 / 2.54 : state.rulerUnit === 'in' ? 96 : 100));
const sub = computed(() => {
  const u = unitPx.value * z.value;
  if (state.rulerUnit === 'px') return u / 10 >= 5 ? 10 : 2;
  if (state.rulerUnit === 'in') return u / 8 >= 5 ? 8 : u / 4 >= 5 ? 4 : 2;
  return u / 10 >= 4 ? 10 : 2;
});
function ticks(from: number, to: number) {
  const step = unitPx.value / sub.value;
  const out: { p: number; len: number; label?: string }[] = [];
  const i0 = Math.ceil(from / step);
  const i1 = Math.floor(to / step);
  for (let i = i0; i <= i1; i++) {
    const major = i % sub.value === 0;
    const half = sub.value % 2 === 0 && i % (sub.value / 2) === 0;
    const v = i / sub.value;
    out.push({ p: i * step, len: major ? 9 : half ? 6 : 3, label: major && i !== 0 ? String(Math.abs(state.rulerUnit === 'px' ? v * 100 : v)) : major ? '0' : undefined });
  }
  return out;
}
const hTicks = computed(() => ticks(-ml.value, pg.value.width - ml.value));
const vSegments = computed(() => boxes.value.map((b) => ({ top: b.top, h: b.h, capY: b.capY, ticks: ticks(0, b.h) })));
const selExtent = computed(() => {
  const els = selectedElements.value;
  if (!els.length) return null;
  const rs = els.map(absRect);
  const x0 = Math.min(...rs.map((r) => r.x));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y0 = Math.min(...rs.map((r) => r.y));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x0, x1, y0, y1 };
});
</script>

<template>
  <div
    ref="scroller"
    class="surface-scroller"
    :class="{
      'tool-cursor': !!state.tool,
      'brush-cursor': !!state.formatBrush,
      'col-resize-cursor': borderHover === 'col',
      'row-resize-cursor': borderHover === 'row',
      'col-moving': drag?.kind === 'colMove' && drag.moved,
    }"
    @wheel="onWheel"
    @scroll="picker = null"
  >
    <div class="surface-grid">
      <div class="ruler-corner" :title="'Units: ' + state.rulerUnit" />
      <div class="hruler" :style="{ width: canvasW + 'px' }">
        <svg :width="canvasW" :height="RULER">
          <rect :x="PAD" y="0" :width="pg.width * z" :height="RULER" fill="#e5e9ef" />
          <rect :x="PAD + ml * z" y="0" :width="cw * z" :height="RULER" fill="#ffffff" />
          <rect v-if="selExtent" :x="PAD + selExtent.x0 * z" y="0" :width="(selExtent.x1 - selExtent.x0) * z" :height="RULER" fill="#dbeafe" />
          <g v-for="(t, i) in hTicks" :key="i">
            <line :x1="PAD + (ml + t.p) * z" :x2="PAD + (ml + t.p) * z" :y1="RULER" :y2="RULER - t.len" stroke="#64748b" stroke-width="1" />
            <text v-if="t.label" :x="PAD + (ml + t.p) * z + 2" y="10" font-size="9" fill="#475569">{{ t.label }}</text>
          </g>
        </svg>
      </div>
      <div class="vruler" :style="{ height: canvasH + 'px' }">
        <svg :width="RULER" :height="canvasH">
          <g v-for="(s, si) in vSegments" :key="si">
            <rect x="0" :y="PAD + s.capY * z" :width="RULER" :height="CAP * z" fill="#e5e9ef" />
            <rect x="0" :y="PAD + s.top * z" :width="RULER" :height="s.h * z" fill="#ffffff" />
            <g v-for="(t, i) in s.ticks" :key="i">
              <line :y1="PAD + (s.top + t.p) * z" :y2="PAD + (s.top + t.p) * z" :x1="RULER" :x2="RULER - t.len" stroke="#64748b" stroke-width="1" />
              <text v-if="t.label && t.p > 0" :x="2" :y="PAD + (s.top + t.p) * z - 2" font-size="9" fill="#475569">{{ t.label }}</text>
            </g>
          </g>
          <rect v-if="selExtent" x="0" :y="PAD + selExtent.y0 * z" :width="5" :height="(selExtent.y1 - selExtent.y0) * z" fill="#93c5fd" />
        </svg>
      </div>

      <div class="canvas-area" :style="{ width: canvasW + 'px', height: canvasH + 'px', overflow: 'hidden' }">
        <div
          ref="pageEl"
          class="page"
          :style="{ width: pg.width + 'px', height: totalH + 'px', transform: `scale(${z})` }"
          @mousedown="onMouseDown"
          @mousemove="onPointerMove"
          @mouseleave="pointer.inside = false"
          @dblclick="onDblClick"
          @contextmenu="onContextMenu"
          @dragover="onDragOver"
          @drop.prevent="onDrop"
          @dragleave="dropHint = null"
        >
          <template v-for="bx in boxes" :key="bx.band.id">
            <div class="band-caption" :class="{ sel: state.selectedBandId === bx.band.id }" :style="{ top: bx.capY + 'px', height: CAP + 'px' }" :data-band-cap="bx.band.id">
              <Rows3 :size="12" class="chev" />
              <span>{{ bx.caption }}</span>
              <span v-for="tg in bandTags(bx.band)" :key="tg" class="tag">{{ tg }}</span>
              <span style="flex: 1" />
              <span class="muted" style="font-weight: normal">{{ Math.round(bx.h) }}px</span>
              <button class="icon-btn" style="width: 18px; height: 16px" title="Band menu" @mousedown.stop @click.stop="bandMenu($event, bx.band)">
                <MoreHorizontal :size="12" />
              </button>
            </div>
            <div class="band-body" :class="{ 'hidden-band': !bx.band.visible }" :data-band-id="bx.band.id" :style="{ top: bx.top + 'px', height: bx.h + 'px', ...gridStyle(bx.band) }">
              <div class="band-margin l" :style="{ width: ml + 'px' }" />
              <div class="band-margin r" :style="{ width: mr + 'px' }" />
              <ElementView
                v-for="el in elementsByBand[bx.band.id] ?? []"
                :key="el.id"
                :el="el"
                :left="ml + el.x"
                :band-type="bx.band.type"
                :ds-id="bx.band.detailReportId ? dataSourceOfBand(bx.band.id) : null"
                :selected="selSet.has(el.id)"
                :dragging="draggingIds.has(el.id)"
              />
            </div>
            <div class="band-resizer" :class="{ active: bandPreview?.id === bx.band.id }" :data-band-resize="bx.band.id" :style="{ top: bx.top + bx.h - 3 + 'px' }" title="Drag to resize band" />
          </template>

          <div v-for="(g, i) in ghosts" :key="'g' + i" class="ghost" :style="{ left: g.x + 'px', top: g.y + 'px', width: g.w + 'px', height: g.h + 'px' }" />
          <div
            v-for="g in colGrips"
            :key="'cg' + g.col"
            class="col-grip"
            :class="{ active: g.active }"
            :data-col-grip="g.col"
            :data-table="g.table"
            title="Drag left or right to move this column · click to select the column"
            :style="{ left: g.x + 1 / z + 'px', top: g.y + 'px', width: Math.max(0, g.w - 2 / z) + 'px', height: g.h + 'px', borderRadius: 3 / z + 'px' }"
          >
            <svg :width="14 / z" :height="6 / z" viewBox="0 0 14 6"><circle v-for="k in 6" :key="k" :cx="2 + ((k - 1) % 3) * 5" :cy="k <= 3 ? 1.5 : 4.5" r="1.1" fill="currentColor" /></svg>
          </div>
          <template v-if="colMoveMarks">
            <div class="col-move-ghost" :class="{ blocked: colMoveMarks.blocked }" :style="{ left: colMoveMarks.ghost.x + 'px', top: colMoveMarks.ghost.y + 'px', width: colMoveMarks.ghost.w + 'px', height: colMoveMarks.ghost.h + 'px' }" />
            <div v-for="(l, i) in colMoveMarks.lines" :key="'cm' + i" class="col-move-line" :style="{ left: l.x + 'px', top: l.y + 'px', width: l.w + 'px', height: l.h + 'px' }" />
          </template>
          <div v-if="ctRect && !drag" class="cell-sel" :style="{ left: ctRect.x + 'px', top: ctRect.y + 'px', width: ctRect.w + 'px', height: ctRect.h + 'px' }" />
          <div
            v-for="h in handles"
            :key="h.key"
            class="handle"
            :class="{ primary: h.primary }"
            :data-handle="h.h"
            :data-owner="h.owner"
            :style="{ left: h.x + 'px', top: h.y + 'px', width: h.s + 'px', height: h.s + 'px', cursor: CURSORS[h.h], borderWidth: 1 / z + 'px' }"
          />
          <div
            v-if="cellRect && (!drag || drag.kind === 'cells')"
            class="cell-sel"
            :class="{ multi: cellRect.multi }"
            :style="{ left: cellRect.x + 'px', top: cellRect.y + 'px', width: cellRect.w + 'px', height: cellRect.h + 'px' }"
          />
          <div v-if="marqueeRect" class="marquee" :style="{ left: marqueeRect.x + 'px', top: marqueeRect.y + 'px', width: marqueeRect.w + 'px', height: marqueeRect.h + 'px' }" />
          <div v-if="guides.x !== null" class="snapline" :style="{ left: guides.x + 'px', top: 0, width: 1 / z + 'px', height: totalH + 'px' }" />
          <div v-if="guides.y !== null" class="snapline" :style="{ top: guides.y + 'px', left: 0, height: 1 / z + 'px', width: pg.width + 'px' }" />
          <div
            v-if="dropHint"
            class="drop-hint"
            :class="{ bind: dropHint.bind }"
            :style="{ left: dropHint.x + 'px', top: dropHint.y + 'px', width: dropHint.w + 'px', height: dropHint.h + 'px' }"
          />
          <textarea
            v-if="inlineEdit"
            ref="inlineRef"
            class="inline-editor"
            :value="inlineEdit.value"
            :style="{ left: inlineEdit.x + 'px', top: inlineEdit.y + 'px', width: inlineEdit.w + 'px', height: inlineEdit.h + 'px', ...inlineEdit.css }"
            @keydown="onInlineKey"
            @blur="commitInline"
            @mousedown.stop
          />
        </div>
      </div>
    </div>
    <FieldPicker
      v-if="picker"
      :key="picker.id + (picker.cell ? picker.cell.row + '_' + picker.cell.col : '') + (picker.zone ?? '')"
      :x="picker.x"
      :y="picker.y"
      :width="picker.w"
      :current="picker.current"
      :title="picker.title"
      :data-source-id="picker.dataSourceId"
      :master-data-source-id="picker.masterDataSourceId"
      :allow-text="picker.allowText"
      @choose="onPick"
      @set-text="onPickerSetText"
      @edit-text="onPickerText"
      @expression="onPickerExpression"
      @clear="onPickerClear"
      @close="picker = null"
    />
  </div>
</template>
