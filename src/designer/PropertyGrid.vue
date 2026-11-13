<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDown, ChevronRight, Columns3, Rows3, TableCellsMerge, TableCellsSplit, Trash2, Upload } from 'lucide-vue-next';
import ColorInput from '../components/ColorInput.vue';
import FontPicker from '../components/FontPicker.vue';
import ExprInput from '../components/ExprInput.vue';
import { bandCaption, resolveStyle } from '../model/defaults';
import { cellsIn, rangeOf, spanOf } from '../model/table';
import type { ReportElement, TableElement } from '../model/types';
import { FORMAT_PRESETS } from '../engine/format';
import {
  getPath,
  mutate,
  openDialog,
  primaryElement,
  selectedBand,
  selectedElements,
  setBandProp,
  setElementProp,
  moveTableHeaderRow,
  updateDetailReport,
  setPageProp,
  setReportProp,
  state,
  tableHeaderRepeats,
  tableOp,
  canMergeCells,
  canUnmergeCells,
  mergeCells,
  unmergeCells,
  findElement,
  notify,
} from '../store/designer';
import { PAPER_SIZES, pxToMm } from '../model/defaults';
import { webImageToDataUrl } from '../export/raster';

const canMerge = computed(() => canMergeCells());
const canUnmerge = computed(() => canUnmergeCells());
import { bandProps, CELL_PROPS, elementProps, REPORT_PROPS, type PropDef } from './propertyDefs';

const filter = ref('');
const collapsed = ref<Record<string, boolean>>({});
const help = ref<PropDef | null>(null);

type Target = { kind: 'cell'; el: TableElement; obj: any } | { kind: 'elements'; els: ReportElement[] } | { kind: 'band' } | { kind: 'report' };

const target = computed<Target>(() => {
  const els = selectedElements.value;
  const cell = state.selectedCell;
  if (cell && els.length === 1 && els[0].id === cell.id && els[0].type === 'table') {
    const obj = (els[0] as TableElement).rows[cell.row]?.cells[cell.col];
    if (obj) return { kind: 'cell', el: els[0] as TableElement, obj };
  }
  if (els.length) return { kind: 'elements', els };
  if (selectedBand.value) return { kind: 'band' };
  return { kind: 'report' };
});

const defs = computed<PropDef[]>(() => {
  const t = target.value;
  if (t.kind === 'cell') return CELL_PROPS;
  if (t.kind === 'elements') {
    let list = elementProps(t.els[t.els.length - 1]);
    for (const e of t.els) {
      const paths = new Set(elementProps(e).map((p) => p.path));
      list = list.filter((p) => paths.has(p.path));
    }
    if (t.els.length > 1) list = list.filter((p) => p.path !== 'name');
    return list;
  }
  if (t.kind === 'band') return bandProps(selectedBand.value!);
  return REPORT_PROPS;
});

const groups = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const out: { cat: string; items: PropDef[] }[] = [];
  for (const d of defs.value) {
    if (f && !d.label.toLowerCase().includes(f) && !d.path.toLowerCase().includes(f)) continue;
    let g = out.find((x) => x.cat === d.cat);
    if (!g) out.push((g = { cat: d.cat, items: [] }));
    g.items.push(d);
  }
  return out;
});

const header = computed(() => {
  const t = target.value;
  if (t.kind === 'cell') {
    const c = state.selectedCell!;
    const rg = rangeOf(t.el, { row: c.row, col: c.col }, { row: c.row2 ?? c.row, col: c.col2 ?? c.col });
    if (rg.r1 > rg.r0 || rg.c1 > rg.c0) {
      const n = cellsIn(t.el, rg).length;
      return { title: `${t.el.name} — ${n} cell${n === 1 ? '' : 's'} selected`, sub: n === 1 ? 'Merged cell — changes apply to it' : 'Changes apply to all selected cells · right-click ▸ Merge Cells' };
    }
    const sp = spanOf(t.obj);
    const merged = sp.cs > 1 || sp.rs > 1 ? ` · merged ${sp.cs}×${sp.rs}` : '';
    return { title: `${t.el.name} — cell [${c.row + 1}, ${c.col + 1}]`, sub: 'Table cell' + merged };
  }
  if (t.kind === 'elements') return t.els.length === 1 ? { title: t.els[0].name, sub: typeName(t.els[0]) } : { title: `${t.els.length} controls selected`, sub: 'Common properties' };
  if (t.kind === 'band') return { title: bandCaption(state.report, selectedBand.value!), sub: 'Band' };
  return { title: state.report.name || 'Report', sub: 'Report' };
});

function typeName(e: ReportElement) {
  return (
    {
      text: e.type === 'text' && e.expression ? 'Data Field (Label)' : 'Label',
      image: 'Picture Box',
      line: 'Line',
      shape: 'Shape',
      barcode: 'Barcode',
      chart: 'Chart',
      checkbox: 'Check Box',
      pageInfo: 'Page Info',
      table: 'Table',
      crosstab: 'Cross Tab',
    } as Record<string, string>
  )[e.type];
}

const MIXED = Symbol('mixed');
function getVal(d: PropDef): any {
  const t = target.value;
  if (t.kind === 'cell') return getPath(t.obj, d.path);
  if (t.kind === 'elements') {
    const vals = t.els.map((e) => getPath(e, d.path));
    const first = JSON.stringify(vals[0]);
    return vals.every((v) => JSON.stringify(v) === first) ? vals[0] : MIXED;
  }
  if (t.kind === 'band') {
    const b = selectedBand.value!;
    if (d.path.startsWith('dr.')) {
      const dr = state.report.detailReports.find((x) => x.id === b.detailReportId);
      return dr ? getPath(dr, d.path.slice(3)) : undefined;
    }
    if (d.path.startsWith('group.')) {
      const g = state.report.groups.find((x) => x.id === b.groupId);
      return g ? getPath(g, d.path.slice(6)) : undefined;
    }
    return getPath(b, d.path);
  }
  return getPath(state.report, d.path);
}

/** inherited (effective) value for style.* props */
function inherited(d: PropDef): any {
  if (!d.inherit) return undefined;
  const t = target.value;
  const key = d.path.slice(6);
  if (t.kind === 'cell') return (resolveStyle(state.report, t.el.styleName, t.el.style) as any)[key];
  if (t.kind === 'elements') {
    const e = t.els[t.els.length - 1];
    return (resolveStyle(state.report, e.styleName, {}) as any)[key];
  }
  return undefined;
}

function setVal(d: PropDef, v: any) {
  const t = target.value;
  if (t.kind === 'cell' || t.kind === 'elements') {
    if (d.path === 'columns') return setColumns(v);
    setElementProp(d.path, v);
  } else if (t.kind === 'band') {
    const b = selectedBand.value!;
    if (d.path.startsWith('dr.') && b.detailReportId) {
      updateDetailReport(b.detailReportId, { [d.path.slice(3)]: v });
      return;
    }
    if (d.path.startsWith('group.')) {
      mutate((r) => {
        const g = r.groups.find((x) => x.id === b.groupId);
        if (g) (g as any)[d.path.slice(6)] = v;
      }, 'group:' + d.path);
    } else setBandProp(b.id, d.path, v);
  } else if (d.path.startsWith('page.')) {
    if (d.path === 'page.paper' && v === 'Custom') openDialog('pageSetup');
    else setPageProp(d.path, v);
  } else setReportProp(d.path, v);
}
const mmVal = (d: PropDef) => {
  const v = getVal(d);
  return typeof v === 'number' ? Math.round(pxToMm(v) * 10) / 10 : '';
};

function setColumns(text: string) {
  const el = primaryElement.value;
  if (!el || el.type !== 'table') return;
  const nums = String(text)
    .split(/[,;\s]+/)
    .map(Number)
    .filter((n) => n > 0);
  if (nums.length !== el.columns.length) return;
  mutate((r) => {
    const t = r.elements.find((e) => e.id === el.id) as TableElement;
    t.columns = nums;
    t.width = nums.reduce((a, b) => a + b, 0);
  });
}

const isSet = (d: PropDef) => {
  const v = getVal(d);
  return d.inherit ? v !== undefined && v !== MIXED : false;
};
const display = (d: PropDef) => {
  const v = getVal(d);
  if (v === MIXED) return '';
  if (d.editor === 'columns') return (v as number[]).join(', ');
  return v ?? '';
};
const numVal = (d: PropDef) => {
  const v = getVal(d);
  return v === MIXED || v === undefined ? '' : v;
};
const boolVal = (d: PropDef) => {
  const v = getVal(d);
  if (v === MIXED) return false;
  return v === undefined ? !!inherited(d) : !!v;
};
function onNumber(d: PropDef, e: Event) {
  const s = (e.target as HTMLInputElement).value;
  if (s === '') return setVal(d, d.inherit ? undefined : 0);
  let n = Number(s);
  if (isNaN(n)) return;
  if (d.min !== undefined) n = Math.max(d.min, n);
  setVal(d, n);
}
function toggleBorder(d: PropDef, side: string) {
  const cur = (getVal(d) === MIXED ? '' : getVal(d) ?? inherited(d) ?? '') as string;
  if (side === 'all') return setVal(d, 'tlbr');
  if (side === 'none') return setVal(d, '');
  setVal(d, cur.includes(side) ? cur.replace(side, '') : cur + side);
}
function borderOn(d: PropDef, side: string) {
  const v = getVal(d);
  const s = (v === MIXED ? '' : v ?? inherited(d) ?? '') as string;
  return s.includes(side);
}
/**
 * A web address in "Image": the picture shows at once, then it is downloaded and kept inside the report (like Upload),
 * so it also prints and exports (PDF, Excel, Word, PNG) — many websites let a browser show a picture but not copy it.
 */
async function setImage(d: PropDef, raw: string) {
  const v = raw.trim();
  if (v === '(embedded image)') return;
  setVal(d, v);
  if (!/^https?:\/\//i.test(v)) return;
  const t = target.value;
  const ids = t.kind === 'elements' ? t.els.map((e) => e.id) : null;
  const data = await webImageToDataUrl(v);
  if (!data) {
    notify('The picture shows here, but that website does not let ReportTool download it, so PDF, Excel, Word and image exports would leave it out. Save the picture to your computer and use the Upload button next to the address.', 'error');
    return;
  }
  // only where the address is still the one typed (the user may have moved on)
  if (ids) {
    const still = ids.filter((id) => getPath(findElement(id) ?? {}, d.path) === v);
    if (!still.length) return;
    setElementProp(d.path, data, still);
  } else if (getVal(d) === v) setVal(d, data);
  else return;
  notify('Picture saved into the report — it prints and exports everywhere now', 'success');
}
function pickImage(d: PropDef) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setVal(d, String(rd.result));
    rd.readAsDataURL(f);
  };
  inp.click();
}
const formatRulesCount = computed(() => primaryElement.value?.formatRules?.length ?? 0);
const repeatingHeader = computed(() => {
  const el = primaryElement.value;
  if (selectedElements.value.length !== 1 || !tableHeaderRepeats(el)) return null;
  const band = state.report.bands.find((b) => b.id === el!.bandId);
  const section = band?.type === 'drDetail';
  return { id: el!.id, band: band?.type === 'detail' ? 'Detail' : section ? 'section Detail' : 'Group Footer', section };
});
const dataSources = computed(() => state.report.dataSources);
</script>

<template>
  <div class="pgrid">
    <div class="pgrid-head">
      <div class="title">{{ header.title }}</div>
      <div class="sub">{{ header.sub }}</div>
      <input v-model="filter" class="pgrid-search" placeholder="Search properties…" />
    </div>

    <div v-if="repeatingHeader" class="header-hint">
      <b>The top row repeats for every record.</b> This table is in the {{ repeatingHeader.band }} band, which prints once per row. Move the caption row
      {{ repeatingHeader.section ? 'to the section header' : 'to the Page Header' }} so it prints once and only the data row repeats.
      <button v-if="repeatingHeader.section" class="btn small primary" @click="moveTableHeaderRow(repeatingHeader.id, 'section')">Move header row to Section Header</button>
      <button v-else class="btn small primary" @click="moveTableHeaderRow(repeatingHeader.id, 'pageHeader')">Move header row to Page Header</button>
    </div>
    <div v-if="target.kind === 'cell'" class="row" style="padding: 6px 8px; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--border)">
      <button class="btn small" :disabled="!canMerge" title="Merge the selected cells (Shift+click or drag across cells to select them)" @click="mergeCells"><TableCellsMerge :size="12" />Merge</button>
      <button v-if="canUnmerge" class="btn small" title="Split the merged cell" @click="unmergeCells"><TableCellsSplit :size="12" />Unmerge</button>
      <button class="btn small" @click="tableOp('insertRowAbove')"><Rows3 :size="12" />Row above</button>
      <button class="btn small" @click="tableOp('insertRowBelow')"><Rows3 :size="12" />Row below</button>
      <button class="btn small" @click="tableOp('insertColLeft')"><Columns3 :size="12" />Col left</button>
      <button class="btn small" @click="tableOp('insertColRight')"><Columns3 :size="12" />Col right</button>
      <button class="btn small danger" @click="tableOp('deleteRow')"><Trash2 :size="12" />Row</button>
      <button class="btn small danger" @click="tableOp('deleteCol')"><Trash2 :size="12" />Column</button>
      <button class="btn small" @click="state.selectedCell = null">Select table</button>
    </div>

    <template v-for="g in groups" :key="g.cat">
      <div class="pcat" @click="collapsed[g.cat] = !collapsed[g.cat]">
        <component :is="collapsed[g.cat] ? ChevronRight : ChevronDown" :size="13" />{{ g.cat }}
      </div>
      <template v-if="!collapsed[g.cat]">
        <div v-for="d in g.items" :key="d.path" class="prow" @mouseenter="help = d">
          <div class="plabel" :class="{ set: isSet(d) }" :title="d.path">{{ d.label }}</div>
          <div class="pval">
            <template v-if="d.editor === 'text'">
              <input type="text" :value="display(d)" @change="setVal(d, ($event.target as HTMLInputElement).value)" />
            </template>
            <template v-else-if="d.editor === 'textarea'">
              <textarea :value="display(d)" @change="setVal(d, ($event.target as HTMLTextAreaElement).value)" />
            </template>
            <template v-else-if="d.editor === 'number'">
              <input type="number" :step="d.step ?? 1" :value="numVal(d)" :placeholder="d.inherit ? String(inherited(d) ?? '') : ''" @change="onNumber(d, $event)" />
            </template>
            <template v-else-if="d.editor === 'color'">
              <ColorInput :model-value="getVal(d) === MIXED ? undefined : getVal(d)" :placeholder="d.inherit ? inherited(d) || 'none' : 'none'" @update:model-value="setVal(d, d.inherit ? $event : $event ?? '')" />
            </template>
            <template v-else-if="d.editor === 'bool'">
              <input type="checkbox" :checked="boolVal(d)" @change="setVal(d, ($event.target as HTMLInputElement).checked)" />
              <span v-if="d.inherit && getVal(d) === undefined" class="inherited" style="font-size: 11px">inherited</span>
            </template>
            <template v-else-if="d.editor === 'select'">
              <select :value="getVal(d) === MIXED ? '' : getVal(d) ?? inherited(d)" @change="setVal(d, ($event.target as HTMLSelectElement).value)">
                <option v-if="getVal(d) === MIXED" value="" disabled>(mixed)</option>
                <option v-for="o in d.options" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </template>
            <template v-else-if="d.editor === 'font'">
              <FontPicker width="100%" :model-value="getVal(d) === MIXED ? '' : (getVal(d) ?? '')" :placeholder="inherited(d) ?? ''" @update:model-value="setVal(d, $event || undefined)" />
            </template>
            <template v-else-if="d.editor === 'expression'">
              <ExprInput :model-value="getVal(d) === MIXED ? '' : getVal(d) ?? ''" :title="d.label" @update:model-value="setVal(d, $event)" />
            </template>
            <template v-else-if="d.editor === 'format'">
              <input type="text" list="pg-formats" :value="display(d)" placeholder="e.g. n2, c, yyyy-MM-dd" @change="setVal(d, ($event.target as HTMLInputElement).value)" />
              <select style="flex: 0 0 22px; width: 22px; padding: 0" title="Presets" :value="''" @change="setVal(d, ($event.target as HTMLSelectElement).value)">
                <option value="" disabled>Presets</option>
                <option v-for="p in FORMAT_PRESETS" :key="p.label" :value="p.value">{{ p.label }}</option>
              </select>
              <datalist id="pg-formats"><option v-for="p in FORMAT_PRESETS" :key="p.label" :value="p.value">{{ p.label }}</option></datalist>
            </template>
            <template v-else-if="d.editor === 'borders'">
              <div class="border-toggles">
                <button :class="{ on: borderOn(d, 't') }" title="Top" @click="toggleBorder(d, 't')">T</button>
                <button :class="{ on: borderOn(d, 'r') }" title="Right" @click="toggleBorder(d, 'r')">R</button>
                <button :class="{ on: borderOn(d, 'b') }" title="Bottom" @click="toggleBorder(d, 'b')">B</button>
                <button :class="{ on: borderOn(d, 'l') }" title="Left" @click="toggleBorder(d, 'l')">L</button>
                <button title="All" @click="toggleBorder(d, 'all')">▣</button>
                <button title="None" @click="toggleBorder(d, 'none')">□</button>
              </div>
            </template>
            <template v-else-if="d.editor === 'image'">
              <img v-if="getVal(d) && getVal(d) !== MIXED" :src="getVal(d)" style="width: 24px; height: 24px; object-fit: contain; border: 1px solid var(--border)" />
              <input type="text" placeholder="URL or upload" :value="String(getVal(d) ?? '').startsWith('data:') ? '(embedded image)' : display(d)" @change="setImage(d, ($event.target as HTMLInputElement).value)" />
              <button class="icon-btn" title="Upload image" @click="pickImage(d)"><Upload :size="14" /></button>
            </template>
            <template v-else-if="d.editor === 'styleName'">
              <select :value="getVal(d) === MIXED ? '' : getVal(d) ?? ''" @change="setVal(d, ($event.target as HTMLSelectElement).value || undefined)">
                <option value="">(none)</option>
                <option v-for="s in state.report.styles" :key="s.id" :value="s.name">{{ s.name }}</option>
              </select>
              <button class="btn small" title="Edit style sheet" @click="openDialog('styles')">…</button>
            </template>
            <template v-else-if="d.editor === 'formatRules'">
              <button class="btn small" :disabled="selectedElements.length !== 1" @click="openDialog('formatRules')">Edit rules ({{ formatRulesCount }})</button>
            </template>
            <template v-else-if="d.editor === 'columns'">
              <input type="text" :value="display(d)" title="Comma separated column widths" @change="setVal(d, ($event.target as HTMLInputElement).value)" />
            </template>
            <template v-else-if="d.editor === 'paper'">
              <select :value="getVal(d)" @change="setVal(d, ($event.target as HTMLSelectElement).value)">
                <option v-for="(s, k) in PAPER_SIZES" :key="k" :value="k">{{ s.label }}</option>
                <option value="Custom">Custom…</option>
              </select>
            </template>
            <template v-else-if="d.editor === 'mm'">
              <input
                type="number"
                step="0.1"
                min="0"
                :value="mmVal(d)"
                :disabled="d.path === 'page.height' && state.report.page.autoHeight"
                @change="($event.target as HTMLInputElement).value !== '' && setVal(d, Number(($event.target as HTMLInputElement).value))"
              />
            </template>
            <template v-else-if="d.editor === 'detailReport'">
              <button class="btn small" @click="openDialog('detailReports', { id: selectedBand?.detailReportId })">Section settings…</button>
            </template>
            <template v-else-if="d.editor === 'dataSource'">
              <select :value="getVal(d) ?? ''" @change="setVal(d, ($event.target as HTMLSelectElement).value || null)">
                <option value="">(none)</option>
                <option v-for="ds in dataSources" :key="ds.id" :value="ds.id">{{ ds.name }}</option>
              </select>
              <button class="btn small" title="Manage data sources" @click="openDialog('dataSources')">…</button>
            </template>
            <button v-if="isSet(d)" class="reset-btn" title="Reset to inherited value" @click="setVal(d, undefined)">×</button>
          </div>
        </div>
      </template>
    </template>
    <div v-if="help" class="phelp">
      <b>{{ help.label }}</b> <span class="muted">({{ help.path }})</span>
      <div v-if="help.help">{{ help.help }}</div>
    </div>
  </div>
</template>
