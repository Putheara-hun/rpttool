<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowUpDown,
  Bold,
  BookOpen,
  BringToFront,
  Calculator,
  ChartColumn,
  ClipboardPaste,
  Copy,
  Database,
  FileBox,
  Grid3x3,
  Group,
  Image,
  Info,
  Italic,
  Keyboard,
  LayoutTemplate,
  Magnet,
  Maximize,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Palette,
  QrCode,
  Barcode,
  Ruler,
  Scissors,
  SendToBack,
  Settings,
  Shrink,
  Square,
  SquareCheck,
  Stamp,
  Strikethrough,
  Table,
  Table2,
  Trash2,
  Type,
  Underline,
  Variable,
  WandSparkles,
  Hash,
  ZoomIn,
  ZoomOut,
  Rows3,
  Spline,
  RectangleHorizontal,
  RectangleVertical,
  UnfoldHorizontal,
  Layers,
  Paintbrush,
  CopyPlus,
  Sigma,
  TableCellsMerge,
  TableCellsSplit,
  BetweenHorizontalStart,
  BetweenHorizontalEnd,
  BetweenVerticalStart,
  BetweenVerticalEnd,
  Columns3,
} from 'lucide-vue-next';
import {
  addBand,
  addDetailReport,
  addTotals,
  canMergeCells,
  canUnmergeCells,
  convertToTotals,
  equalizeColumns,
  fitTableToPageWidth,
  matchTableColumns,
  inSummaryBand,
  mergeCells,
  tableOp,
  totalTargets,
  unmergeCells,
  alignSelection,
  alignToGrid,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  pasteFromSystem,
  startFormatPainter,
  writeSystemClipboard,
  distribute,
  fitBandToContent,
  fitPageWidthToContent,
  notify,
  openDialog,
  pasteClipboard,
  primaryElement,
  sameSize,
  selectedElements,
  setPageProp,
  state,
  zOrder,
} from '../store/designer';
import { MARGIN_PRESETS, marginPreset, PAPER_SIZES, pageSizeText, pxToMm, type ToolId } from '../model/defaults';
import { applyColor, applyLineStyle, applyLineWidth, hasTextStyle, openContextMenu, selectionColor, selectionLine, selectionStyle, setStyle } from './ui';
import type { LineStyle } from '../model/types';

const LINE_STYLES: { value: LineStyle; label: string; dash: string }[] = [
  { value: 'solid', label: 'Solid', dash: '' },
  { value: 'dashed', label: 'Dashed', dash: '5 3' },
  { value: 'dotted', label: 'Dotted', dash: '2 2' },
];
import ColorPicker from '../components/ColorPicker.vue';
import FontPicker from '../components/FontPicker.vue';
import type { ReportElement } from '../model/types';
import { normColor } from '../export/raster';

const tab = ref<'home' | 'insert' | 'layout' | 'report' | 'view'>('home');
const n = computed(() => selectedElements.value.length);
const st = computed(() => selectionStyle.value);
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 60, 72];
const hex = (c?: string) => normColor(c)?.hex ?? '#000000';

function toggle(key: 'bold' | 'italic' | 'underline' | 'strike') {
  setStyle(key, !st.value?.[key]);
}
function setBorders(v: string) {
  if (v === 'all') return setStyle('borders', 'tlbr');
  if (v === 'none') return setStyle('borders', '');
  const cur = st.value?.borders ?? '';
  setStyle('borders', cur.includes(v) ? cur.replace(v, '') : cur + v);
}
function pickTool(t: ToolId) {
  state.tool = state.tool === t ? null : t;
  if (state.tool) notify('Click inside a band to place the control (Esc to cancel)');
}
function zoom(f: number) {
  state.zoom = Math.min(4, Math.max(0.25, Math.round(f * 100) / 100));
}
function toggleOrientation() {
  setPageProp('page.orientation', state.report.page.orientation === 'portrait' ? 'landscape' : 'portrait');
}
const sel = primaryElement;
// table cell commands (read the selected cell / range and the table, so they update by themselves)
const hasCell = computed(() => !!state.selectedCell);
const tableSel = computed(() => primaryElement.value?.type === 'table');
/** Home ▸ Table ▸ Columns ▾ */
function columnMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const sel = selectedElements.value.filter((x) => x.type === 'table').length;
  openContextMenu({ clientX: r.left, clientY: r.bottom + 2, preventDefault() {} } as MouseEvent, [
    { label: 'Equal Widths (all / selected columns)', icon: Columns3, action: () => equalizeColumns() },
    { label: sel > 1 ? 'Match Selected Tables to This One' : 'Match Other Tables to This One', icon: AlignHorizontalDistributeCenter, action: () => matchTableColumns() },
    { label: 'Fit to Page Width', icon: MoveHorizontal, action: () => fitTableToPageWidth() },
  ]);
}
const canMerge = computed(() => canMergeCells());
const canUnmerge = computed(() => canUnmergeCells());
const page = computed(() => state.report.page);
const mmText = (px: number) => Math.round(pxToMm(px) * 10) / 10;
const margin = computed(() => marginPreset(state.report.page));
function onPaper(v: string) {
  if (v === 'Custom') openDialog('pageSetup');
  else setPageProp('page.paper', v);
}
function ribbonCopy() {
  const p = copySelection();
  if (p) writeSystemClipboard(p);
}
function ribbonCut() {
  const p = cutSelection();
  if (p) writeSystemClipboard(p);
}
function insertDetailReport() {
  if (!state.report.dataSources.length) {
    notify('Add a data source first — each detail report section reads its own data source');
    openDialog('dataSources');
    return;
  }
  openDialog('detailReports', { id: addDetailReport() });
}
/** Σ Grand Total: the selected Detail table / fields (or all of the Detail band) -> totals in the footer. */
function grandTotal() {
  let src: ReportElement[] = selectedElements.value.filter((e) => e.type === 'table' || e.type === 'text');
  if (!src.length) {
    const det = state.report.bands.find((b) => b.type === 'detail');
    src = state.report.elements.filter((e) => e.bandId === det?.id && (e.type === 'table' || (e.type === 'text' && e.expression.trim())));
  }
  if (!src.length) {
    notify('Select the table or the fields in the Detail band that you want to total');
    return;
  }
  const ids = src.filter((e) => e.bandId === src[0].bandId).map((e) => e.id);
  if (inSummaryBand(src[0])) return convertToTotals(ids);
  const targets = totalTargets(src[0].bandId);
  if (!targets.length) {
    notify('Totals are made from a Detail band (or a section Detail band) — select the data table there');
    return;
  }
  addTotals(targets[0], ids);
}
function onMargins(v: string) {
  if (v === 'custom') openDialog('pageSetup');
  else setPageProp('page.margins', v);
}
</script>

<template>
  <div class="ribbon">
    <div class="ribbon-tabs">
      <button :class="{ on: tab === 'home' }" @click="tab = 'home'">Home</button>
      <button :class="{ on: tab === 'insert' }" @click="tab = 'insert'">Insert</button>
      <button :class="{ on: tab === 'layout' }" @click="tab = 'layout'">Layout</button>
      <button :class="{ on: tab === 'report' }" @click="tab = 'report'">Report</button>
      <button :class="{ on: tab === 'view' }" @click="tab = 'view'">View</button>
    </div>

    <!-- HOME -->
    <div v-if="tab === 'home'" class="ribbon-body">
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" title="Paste (Ctrl+V) — controls, text, Excel cells or pictures" @click="pasteFromSystem()"><ClipboardPaste :size="22" />Paste</button>
          <div class="rstack">
            <button class="rsmall" :disabled="!n" title="Cut (Ctrl+X)" @click="ribbonCut"><Scissors :size="14" />Cut</button>
            <button class="rsmall" :disabled="!n" title="Copy (Ctrl+C)" @click="ribbonCopy"><Copy :size="14" />Copy</button>
            <button
              class="rsmall"
              :class="{ active: !!state.formatBrush }"
              :disabled="!n && !state.formatBrush"
              title="Format Painter: copy the formatting of the selection, then click another control"
              @click="state.formatBrush ? (state.formatBrush = null) : startFormatPainter()"
            >
              <Paintbrush :size="14" />Format Painter
            </button>
          </div>
          <div class="rstack">
            <button class="rsmall" :disabled="!n" title="Duplicate (Ctrl+D)" @click="duplicateSelection"><CopyPlus :size="14" />Duplicate</button>
            <button class="rsmall" :disabled="!n && !state.selectedBandId" title="Delete (Del)" @click="deleteSelection"><Trash2 :size="14" />Delete</button>
          </div>
        </div>
        <div class="rgroup-title">Clipboard</div>
      </div>

      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 460px">
          <div class="rstack">
            <select style="width: 190px" title="Paper size" :value="page.paper" @change="onPaper(($event.target as HTMLSelectElement).value)">
              <option v-for="(s, k) in PAPER_SIZES" :key="k" :value="k">{{ s.label }}</option>
              <option value="Custom">{{ page.paper === 'Custom' ? `Custom (${mmText(page.baseWidth ?? page.width)} x ${mmText(page.height)} mm)` : 'Custom size…' }}</option>
            </select>
            <div class="page-toggle">
              <button :class="{ on: page.orientation === 'portrait' }" title="Portrait" @click="setPageProp('page.orientation', 'portrait')"><RectangleVertical :size="13" />Portrait</button>
              <button :class="{ on: page.orientation === 'landscape' }" title="Landscape" @click="setPageProp('page.orientation', 'landscape')"><RectangleHorizontal :size="13" />Landscape</button>
            </div>
            <select style="width: 190px" title="Margins" :value="margin" @change="onMargins(($event.target as HTMLSelectElement).value)">
              <option v-for="(m, k) in MARGIN_PRESETS" :key="k" :value="k">Margins: {{ m.label }}</option>
              <option value="custom">{{ margin === 'custom' ? 'Margins: Custom' : 'Margins: Custom…' }}</option>
            </select>
          </div>
          <div class="rstack">
            <label class="rsmall" :class="{ active: page.autoWidth }" title="The page grows wider when a control or table goes past the right margin">
              <input type="checkbox" :checked="!!page.autoWidth" @change="setPageProp('page.autoWidth', ($event.target as HTMLInputElement).checked)" /> Auto width (fit content)
            </label>
            <label class="rsmall" :class="{ active: page.autoHeight }" title="Roll paper: one continuous page whose height fits all the content">
              <input type="checkbox" :checked="!!page.autoHeight" @change="setPageProp('page.autoHeight', ($event.target as HTMLInputElement).checked)" /> Auto height (roll paper)
            </label>
            <button class="rsmall" title="Make the paper exactly as wide as the content" @click="fitPageWidthToContent"><UnfoldHorizontal :size="14" />Fit width to content</button>
          </div>
          <button class="rbig" @click="openDialog('pageSetup')"><FileBox :size="22" />Page<br />Setup</button>
        </div>
        <div class="rgroup-title">Page — {{ pageSizeText(page) }}</div>
      </div>

      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 300px">
          <div class="rstack">
            <div class="row" style="gap: 3px">
              <FontPicker class="ribbon-font" width="140px" :disabled="!hasTextStyle" :model-value="st?.fontFamily" @update:model-value="setStyle('fontFamily', $event)" />
              <select style="width: 58px" :disabled="!hasTextStyle" :value="st?.fontSize" @change="setStyle('fontSize', Number(($event.target as HTMLSelectElement).value))">
                <option v-for="s in SIZES" :key="s" :value="s">{{ s }}</option>
                <option v-if="st && !SIZES.includes(st.fontSize)" :value="st.fontSize">{{ st.fontSize }}</option>
              </select>
            </div>
            <div class="row" style="gap: 1px">
              <button class="icon-btn" :class="{ active: st?.bold }" :disabled="!hasTextStyle" title="Bold" @click="toggle('bold')"><Bold :size="15" /></button>
              <button class="icon-btn" :class="{ active: st?.italic }" :disabled="!hasTextStyle" title="Italic" @click="toggle('italic')"><Italic :size="15" /></button>
              <button class="icon-btn" :class="{ active: st?.underline }" :disabled="!hasTextStyle" title="Underline" @click="toggle('underline')"><Underline :size="15" /></button>
              <button class="icon-btn" :class="{ active: st?.strike }" :disabled="!hasTextStyle" title="Strikeout" @click="toggle('strike')"><Strikethrough :size="15" /></button>
              <ColorPicker
                variant="text"
                title="Font color"
                none-label="Automatic"
                style="margin-left: 6px"
                :disabled="!selectionColor.any"
                :model-value="selectionColor.text"
                @update:model-value="applyColor('text', $event)"
              />
              <ColorPicker variant="fill" title="Fill / back color" none-label="No fill" :disabled="!selectionColor.any" :model-value="selectionColor.fill" @update:model-value="applyColor('fill', $event)" />
            </div>
          </div>
        </div>
        <div class="rgroup-title">Font</div>
      </div>

      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 130px">
          <button class="icon-btn" :class="{ active: st?.textAlign === 'left' }" :disabled="!hasTextStyle" title="Align left" @click="setStyle('textAlign', 'left')"><AlignLeft :size="15" /></button>
          <button class="icon-btn" :class="{ active: st?.textAlign === 'center' }" :disabled="!hasTextStyle" title="Center" @click="setStyle('textAlign', 'center')"><AlignCenter :size="15" /></button>
          <button class="icon-btn" :class="{ active: st?.textAlign === 'right' }" :disabled="!hasTextStyle" title="Align right" @click="setStyle('textAlign', 'right')"><AlignRight :size="15" /></button>
          <button class="icon-btn" :class="{ active: st?.textAlign === 'justify' }" :disabled="!hasTextStyle" title="Justify" @click="setStyle('textAlign', 'justify')"><AlignJustify :size="15" /></button>
          <button class="icon-btn" :class="{ active: st?.vAlign === 'top' }" :disabled="!hasTextStyle" title="Top" @click="setStyle('vAlign', 'top')"><AlignVerticalJustifyStart :size="15" /></button>
          <button class="icon-btn" :class="{ active: st?.vAlign === 'middle' }" :disabled="!hasTextStyle" title="Middle" @click="setStyle('vAlign', 'middle')"><AlignVerticalJustifyCenter :size="15" /></button>
          <button class="icon-btn" :class="{ active: st?.vAlign === 'bottom' }" :disabled="!hasTextStyle" title="Bottom" @click="setStyle('vAlign', 'bottom')"><AlignVerticalJustifyEnd :size="15" /></button>
        </div>
        <div class="rgroup-title">Alignment</div>
      </div>

      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 200px">
          <div class="rstack">
            <div class="border-toggles">
              <button :class="{ on: st?.borders?.length === 4 }" :disabled="!hasTextStyle" title="All borders" @click="setBorders('all')">▣</button>
              <button :disabled="!hasTextStyle" title="No borders" @click="setBorders('none')">□</button>
              <button :class="{ on: st?.borders?.includes('t') }" :disabled="!hasTextStyle" title="Top" @click="setBorders('t')">▔</button>
              <button :class="{ on: st?.borders?.includes('b') }" :disabled="!hasTextStyle" title="Bottom" @click="setBorders('b')">▁</button>
              <button :class="{ on: st?.borders?.includes('l') }" :disabled="!hasTextStyle" title="Left" @click="setBorders('l')">▏</button>
              <button :class="{ on: st?.borders?.includes('r') }" :disabled="!hasTextStyle" title="Right" @click="setBorders('r')">▕</button>
            </div>
            <div class="row" style="gap: 4px">
              <div class="line-style-pick" :class="{ disabled: !n }">
                <button
                  v-for="ls in LINE_STYLES"
                  :key="ls.value"
                  type="button"
                  :class="{ on: selectionLine?.style === ls.value }"
                  :disabled="!n"
                  :title="ls.label + ' line / border'"
                  @click="applyLineStyle(ls.value)"
                >
                  <svg width="16" height="10" viewBox="0 0 16 10"><line x1="1" y1="5" x2="15" y2="5" stroke="currentColor" stroke-width="2" :stroke-dasharray="ls.dash" /></svg>
                </button>
              </div>
              <select style="width: 54px" :disabled="!n" :value="selectionLine?.width" title="Line / border width" @change="applyLineWidth(Number(($event.target as HTMLSelectElement).value))">
                <option v-for="w in [0.5, 1, 1.5, 2, 3, 4, 6]" :key="w" :value="w">{{ w }}px</option>
              </select>
              <ColorPicker variant="border" title="Border / line color" none-label="Automatic" :disabled="!selectionColor.any" :model-value="selectionColor.border" @update:model-value="applyColor('border', $event)" />
            </div>
          </div>
        </div>
        <div class="rgroup-title">Borders</div>
      </div>

      <div class="rgroup">
        <div class="rgroup-body">
          <div class="rstack">
            <button class="rsmall" :disabled="!canMerge" title="Merge the selected table cells (Shift+click or drag across cells to select them)" @click="mergeCells"><TableCellsMerge :size="14" />Merge Cells</button>
            <button class="rsmall" :disabled="!canUnmerge" title="Split a merged cell back into single cells" @click="unmergeCells"><TableCellsSplit :size="14" />Unmerge</button>
            <button class="rsmall" :disabled="!tableSel" title="Equal column widths, line up tables, fit to page width" @click="columnMenu"><Columns3 :size="14" />Columns ▾</button>
          </div>
        </div>
        <div class="rgroup-title">Table</div>
      </div>

      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" @click="openDialog('styles')"><Palette :size="22" />Styles</button>
          <button class="rbig" :disabled="!sel" @click="openDialog('formatRules')"><Settings :size="22" />Format<br />Rules</button>
        </div>
        <div class="rgroup-title">Styles</div>
      </div>
    </div>

    <!-- INSERT -->
    <div v-else-if="tab === 'insert'" class="ribbon-body">
      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 640px">
          <button class="rbig" :class="{ active: state.tool === 'text' }" @click="pickTool('text')"><Type :size="22" />Label</button>
          <button class="rbig" :class="{ active: state.tool === 'table' }" @click="pickTool('table')"><Table :size="22" />Table</button>
          <button class="rbig" :class="{ active: state.tool === 'image' }" @click="pickTool('image')"><Image :size="22" />Picture</button>
          <button class="rbig" :class="{ active: state.tool === 'line' }" @click="pickTool('line')"><Minus :size="22" />Line</button>
          <button class="rbig" :class="{ active: state.tool === 'shape' }" @click="pickTool('shape')"><Square :size="22" />Shape</button>
          <button class="rbig" :class="{ active: state.tool === 'barcode' }" @click="pickTool('barcode')"><Barcode :size="22" />Barcode</button>
          <button class="rbig" :class="{ active: state.tool === 'qr' }" @click="pickTool('qr')"><QrCode :size="22" />QR Code</button>
          <button class="rbig" :class="{ active: state.tool === 'chart' }" @click="pickTool('chart')"><ChartColumn :size="22" />Chart</button>
          <button class="rbig" :class="{ active: state.tool === 'crosstab' }" @click="pickTool('crosstab')"><Table2 :size="22" />Cross<br />Tab</button>
          <button class="rbig" :class="{ active: state.tool === 'checkbox' }" @click="pickTool('checkbox')"><SquareCheck :size="22" />Check<br />Box</button>
          <button class="rbig" :class="{ active: state.tool === 'pageNofM' }" @click="pickTool('pageNofM')"><Hash :size="22" />Page<br />Info</button>
        </div>
        <div class="rgroup-title">Controls</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 280px">
          <div class="rstack">
            <button class="rsmall" @click="addBand('reportHeader')"><Rows3 :size="14" />Report Header</button>
            <button class="rsmall" @click="addBand('reportFooter')"><Rows3 :size="14" />Report Footer</button>
          </div>
          <div class="rstack">
            <button class="rsmall" @click="addBand('pageHeader')"><Rows3 :size="14" />Page Header</button>
            <button class="rsmall" @click="addBand('pageFooter')"><Rows3 :size="14" />Page Footer</button>
          </div>
          <button class="rbig" @click="openDialog('groupSort')"><Group :size="22" />Group</button>
          <button class="rbig" title="A section with its own data source, header and repeating rows" @click="insertDetailReport"><Layers :size="22" />Detail<br />Report</button>
          <button
            class="rbig"
            title="Grand total: Sum of the number columns of the selected Detail table (or fields) in the Report Footer. In a section: the section footer. On a footer table: turns it into totals."
            @click="grandTotal"
          >
            <Sigma :size="22" />Grand<br />Total
          </button>
        </div>
        <div class="rgroup-title">Bands</div>
      </div>
    </div>

    <!-- LAYOUT -->
    <div v-else-if="tab === 'layout'" class="ribbon-body">
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" :disabled="!canMerge" title="Merge the selected table cells (Shift+click or drag across cells to select them)" @click="mergeCells"><TableCellsMerge :size="22" />Merge<br />Cells</button>
          <button class="rbig" :disabled="!canUnmerge" title="Split a merged cell back into single cells" @click="unmergeCells"><TableCellsSplit :size="22" />Unmerge<br />Cells</button>
          <div class="rstack">
            <button class="rsmall" :disabled="!hasCell" @click="tableOp('insertRowAbove')"><BetweenHorizontalStart :size="14" />Row Above</button>
            <button class="rsmall" :disabled="!hasCell" @click="tableOp('insertRowBelow')"><BetweenHorizontalEnd :size="14" />Row Below</button>
            <button class="rsmall" :disabled="!hasCell" @click="tableOp('deleteRow')"><Trash2 :size="14" />Delete Row</button>
          </div>
          <div class="rstack">
            <button class="rsmall" :disabled="!hasCell" @click="tableOp('insertColLeft')"><BetweenVerticalStart :size="14" />Column Left</button>
            <button class="rsmall" :disabled="!hasCell" @click="tableOp('insertColRight')"><BetweenVerticalEnd :size="14" />Column Right</button>
            <button class="rsmall" :disabled="!hasCell" @click="tableOp('deleteCol')"><Trash2 :size="14" />Delete Column</button>
          </div>
          <div class="rstack">
            <button class="rsmall" :disabled="!tableSel" title="Make all columns (or the selected columns) the same width" @click="equalizeColumns()"><Columns3 :size="14" />Equal Columns</button>
            <button
              class="rsmall"
              :disabled="!tableSel"
              title="Line up the other tables (or the other selected tables) with the columns of this table"
              @click="matchTableColumns()"
            >
              <AlignHorizontalDistributeCenter :size="14" />Match Tables
            </button>
            <button class="rsmall" :disabled="!tableSel" title="Stretch the table over the full page width" @click="fitTableToPageWidth()"><MoveHorizontal :size="14" />Fit Page Width</button>
          </div>
        </div>
        <div class="rgroup-title">Table</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body" style="max-width: 250px">
          <div class="rstack">
            <button class="rsmall" :disabled="n < 2" @click="alignSelection('left')"><AlignStartVertical :size="14" />Lefts</button>
            <button class="rsmall" :disabled="n < 2" @click="alignSelection('center')"><AlignCenterVertical :size="14" />Centers</button>
            <button class="rsmall" :disabled="n < 2" @click="alignSelection('right')"><AlignEndVertical :size="14" />Rights</button>
          </div>
          <div class="rstack">
            <button class="rsmall" :disabled="n < 2" @click="alignSelection('top')"><AlignStartHorizontal :size="14" />Tops</button>
            <button class="rsmall" :disabled="n < 2" @click="alignSelection('middle')"><AlignCenterHorizontal :size="14" />Middles</button>
            <button class="rsmall" :disabled="n < 2" @click="alignSelection('bottom')"><AlignEndHorizontal :size="14" />Bottoms</button>
          </div>
        </div>
        <div class="rgroup-title">Align (to last selected)</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <div class="rstack">
            <button class="rsmall" :disabled="n < 2" @click="sameSize('width')"><MoveHorizontal :size="14" />Same Width</button>
            <button class="rsmall" :disabled="n < 2" @click="sameSize('height')"><MoveVertical :size="14" />Same Height</button>
            <button class="rsmall" :disabled="n < 2" @click="sameSize('both')"><Maximize :size="14" />Same Size</button>
          </div>
        </div>
        <div class="rgroup-title">Size</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <div class="rstack">
            <button class="rsmall" :disabled="n < 3" @click="distribute('h')"><AlignHorizontalDistributeCenter :size="14" />Horizontal Spacing</button>
            <button class="rsmall" :disabled="n < 3" @click="distribute('v')"><AlignVerticalDistributeCenter :size="14" />Vertical Spacing</button>
          </div>
        </div>
        <div class="rgroup-title">Distribute</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" :disabled="!n" @click="zOrder(true)"><BringToFront :size="22" />Bring to<br />Front</button>
          <button class="rbig" :disabled="!n" @click="zOrder(false)"><SendToBack :size="22" />Send to<br />Back</button>
        </div>
        <div class="rgroup-title">Order</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" :disabled="!n" @click="alignToGrid"><Grid3x3 :size="22" />Align to<br />Grid</button>
          <button class="rbig" :disabled="!state.selectedBandId && !sel" @click="fitBandToContent((state.selectedBandId || sel?.bandId)!)"><Shrink :size="22" />Fit Band<br />to Content</button>
        </div>
        <div class="rgroup-title">Grid &amp; Bands</div>
      </div>
    </div>

    <!-- REPORT -->
    <div v-else-if="tab === 'report'" class="ribbon-body">
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" @click="openDialog('wizard')"><WandSparkles :size="22" />Report<br />Wizard</button>
        </div>
        <div class="rgroup-title">Create</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" @click="openDialog('dataSources')"><Database :size="22" />Data<br />Sources</button>
          <button class="rbig" @click="openDialog('groupSort')"><ArrowUpDown :size="22" />Group,<br />Sort, Filter</button>
          <button class="rbig" @click="openDialog('detailReports')"><Layers :size="22" />Detail<br />Reports</button>
          <button class="rbig" @click="openDialog('parameters')"><Variable :size="22" />Parameters</button>
          <button class="rbig" @click="openDialog('calcFields')"><Calculator :size="22" />Calculated<br />Fields</button>
        </div>
        <div class="rgroup-title">Data</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" @click="openDialog('pageSetup')"><FileBox :size="22" />Page<br />Setup</button>
          <button class="rbig" @click="toggleOrientation"><Spline :size="22" />{{ state.report.page.orientation === 'portrait' ? 'Portrait' : 'Landscape' }}</button>
          <button class="rbig" @click="openDialog('watermark')"><Stamp :size="22" />Watermark</button>
          <button class="rbig" @click="openDialog('styles')"><Palette :size="22" />Style<br />Sheet</button>
        </div>
        <div class="rgroup-title">Page</div>
      </div>
    </div>

    <!-- VIEW -->
    <div v-else class="ribbon-body">
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" @click="zoom(state.zoom - 0.1)"><ZoomOut :size="22" />Zoom Out</button>
          <button class="rbig" @click="zoom(state.zoom + 0.1)"><ZoomIn :size="22" />Zoom In</button>
          <button class="rbig" @click="zoom(1)"><Ruler :size="22" />100%</button>
        </div>
        <div class="rgroup-title">Zoom ({{ Math.round(state.zoom * 100) }}%)</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" :class="{ active: state.showGrid }" @click="state.showGrid = !state.showGrid"><Grid3x3 :size="22" />Show<br />Grid</button>
          <button class="rbig" :class="{ active: state.snapToGrid }" @click="state.snapToGrid = !state.snapToGrid"><Magnet :size="22" />Snap to<br />Grid</button>
          <button class="rbig" :class="{ active: state.snapLines }" @click="state.snapLines = !state.snapLines"><AlignCenterVertical :size="22" />Snap<br />Lines</button>
          <div class="rstack" style="margin-left: 6px">
            <label class="row">Grid <select v-model.number="state.gridSize"><option v-for="g in [2, 4, 5, 8, 10, 16, 20]" :key="g" :value="g">{{ g }} px</option></select></label>
            <label class="row">Ruler <select v-model="state.rulerUnit"><option value="cm">cm</option><option value="in">inch</option><option value="px">px</option></select></label>
          </div>
        </div>
        <div class="rgroup-title">Grid</div>
      </div>
      <div class="rgroup">
        <div class="rgroup-body">
          <button class="rbig" @click="openDialog('about')"><Keyboard :size="22" />Shortcuts<br />&amp; Help</button>
          <button class="rbig" @click="openDialog('about')"><Info :size="22" />About</button>
          <button class="rbig" @click="state.rightTab = 'explorer'"><BookOpen :size="22" />Report<br />Explorer</button>
        </div>
        <div class="rgroup-title">Help</div>
      </div>
    </div>
  </div>
</template>
