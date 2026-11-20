<script setup lang="ts">
import { computed, ref } from 'vue';
import { Calculator, ChevronDown, ChevronRight, Database, DatabaseZap, Hash, Plus, Star, Variable, Workflow } from 'lucide-vue-next';
import { specialFields, type SpecialField } from './specialFields';
import { objectLabel } from '../data/dbApi';
import { addElement, addTableFromFields, dataErrors, fieldsOf, mutate, openDialog, primaryElement, rowsFor, state, type FieldPick } from '../store/designer';
import type { FieldType } from '../model/types';

const collapsed = ref<Record<string, boolean>>({});
const sources = computed(() => state.report.dataSources);
const typeLabel: Record<FieldType, string> = { string: 'abc', number: '123', date: 'dt', boolean: 'y/n' };

// ---- several fields picked (Ctrl / Shift + click) and dragged together become a table with one column per field
const picked = ref<{ ds: string; names: string[] }>({ ds: '', names: [] });
let anchor = '';
const isPicked = (dsId: string, name: string) => picked.value.ds === dsId && picked.value.names.includes(name);
function pick(e: MouseEvent, dsId: string, name: string) {
  const all = fieldsOf(dsId).map((f) => f.name);
  const same = picked.value.ds === dsId;
  if (e.shiftKey && same && anchor) {
    const [a, b] = [all.indexOf(anchor), all.indexOf(name)].sort((x, y) => x - y);
    picked.value = { ds: dsId, names: all.slice(a, b + 1) };
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const names = same ? picked.value.names : [];
    picked.value = { ds: dsId, names: names.includes(name) ? names.filter((n) => n !== name) : all.filter((n) => n === name || names.includes(n)) };
  } else picked.value = { ds: dsId, names: [name] };
  anchor = name;
}
/** the picked fields, in the order of the list */
const pickedFields = (dsId: string): FieldPick[] =>
  fieldsOf(dsId)
    .filter((f) => picked.value.ds === dsId && picked.value.names.includes(f.name))
    .map((f) => ({ expr: `[${f.name}]`, name: f.name, type: f.type }));

function onDrag(e: DragEvent, expr: string, name: string, type: string, dsId?: string) {
  if (!e.dataTransfer) return;
  // a picked field dragged while others are picked too: all of them, as a table
  if (dsId && isPicked(dsId, name) && picked.value.names.length > 1) e.dataTransfer.setData('text/x-rt-fields', JSON.stringify(pickedFields(dsId)));
  else e.dataTransfer.setData('text/x-rt-field', JSON.stringify({ expr, name, type }));
  e.dataTransfer.effectAllowed = 'copy';
}

/** Insert table: the picked fields as a table in the band their data source prints in (Detail, or a section's) */
function insertTable(dsId: string) {
  const sec = dsId === state.report.dataSourceId ? null : sectionsOf(dsId)[0];
  const band = sec ? state.report.bands.find((b) => b.type === 'drDetail' && b.detailReportId === sec.id) : state.report.bands.find((b) => b.type === 'detail' && !b.detailReportId);
  if (!band) return;
  const used = state.report.elements.filter((e) => e.bandId === band.id);
  addTableFromFields(pickedFields(dsId), band.id, 0, used.length ? Math.ceil(Math.max(...used.map((e) => e.y + e.height))) : 0);
  picked.value = { ds: '', names: [] };
}

function addToBand(expr: string, name: string, type: string) {
  const bandId = state.selectedBandId ?? primaryElement.value?.bandId ?? state.report.bands.find((b) => b.type === 'detail')?.id;
  if (!bandId) return;
  const used = state.report.elements.filter((e) => e.bandId === bandId);
  const x = used.length ? Math.max(...used.map((e) => e.x + e.width)) + 4 : 0;
  addElement('field', bandId, x, 2, {
    expression: expr,
    format: type === 'date' ? 'd' : '',
    style: type === 'number' ? { textAlign: 'right' } : {},
  } as any);
}

const specials = computed(() => specialFields(state.report));
function onDragSpecial(e: DragEvent, sf: SpecialField) {
  e.dataTransfer?.setData('text/x-rt-field', JSON.stringify(sf));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
}
function addSpecial(sf: SpecialField) {
  const bandId = state.selectedBandId ?? primaryElement.value?.bandId ?? state.report.bands.find((b) => b.type === 'detail')?.id;
  if (!bandId) return;
  const used = state.report.elements.filter((e) => e.bandId === bandId);
  const x = used.length ? Math.max(...used.map((e) => e.x + e.width)) + 4 : 0;
  addElement(sf.text !== undefined ? 'text' : 'field', bandId, x, 2, {
    text: sf.text ?? '',
    expression: sf.text !== undefined ? '' : sf.expr,
    format: sf.format ?? '',
    style: sf.align ? { textAlign: sf.align } : {},
  } as any);
}

const sectionsOf = (dsId: string) => (state.report.detailReports ?? []).filter((d) => d.dataSourceId === dsId);
function setMain(id: string) {
  mutate((r) => (r.dataSourceId = id));
}
</script>

<template>
  <div class="tree">
    <div class="panel-title">
      <Database :size="14" /> Data Sources
      <button class="icon-btn" style="margin-left: auto; width: 22px; height: 22px" title="Add a stored procedure: its fields and parameters load at once" @click="openDialog('dataSources', { add: 'procedure' })">
        <Workflow :size="14" />
      </button>
      <button class="icon-btn" style="width: 22px; height: 22px" title="Manage data sources" @click="openDialog('dataSources')"><Plus :size="14" /></button>
    </div>
    <div v-if="!sources.length" class="empty-hint">
      No data source yet. <a href="#" @click.prevent="openDialog('dataSources')">Add a data source</a> (sample data, JSON, CSV or a URL) and then drag its fields onto the report.
    </div>
    <template v-for="ds in sources" :key="ds.id">
      <div class="tree-item" :title="ds.id === state.report.dataSourceId ? 'Report data source' : 'Double-click to make this the report data source'" @click="collapsed[ds.id] = !collapsed[ds.id]" @dblclick="setMain(ds.id)">
        <component :is="collapsed[ds.id] ? ChevronRight : ChevronDown" :size="14" />
        <component :is="ds.kind === 'sql' ? DatabaseZap : Database" :size="14" />
        <b :title="ds.kind === 'sql' && ds.sql ? `${ds.sql.connectionName ?? ''} · ${objectLabel(ds.sql)}` : ''">{{ ds.name }}</b>
        <Star v-if="ds.id === state.report.dataSourceId" :size="12" fill="#f59e0b" color="#f59e0b" />
        <span class="type">{{ rowsFor(ds.id).length }} rows</span>
      </div>
      <div v-for="sec in sectionsOf(ds.id)" :key="sec.id" class="hint" style="padding: 0 10px 2px 30px">↳ used by section “{{ sec.name }}”</div>
      <div v-if="dataErrors[ds.id]" class="err" style="padding: 2px 30px">{{ dataErrors[ds.id] }}</div>
      <template v-if="!collapsed[ds.id]">
        <div v-if="picked.ds === ds.id && picked.names.length > 1" class="pick-bar">
          <span class="grow"><b>{{ picked.names.length }} fields</b> — drag them onto the page, or</span>
          <button class="btn small primary" title="Header, data and Grand Total rows, one column per field" @click="insertTable(ds.id)">Insert table</button>
          <button class="btn small" title="Unpick" @click="picked = { ds: '', names: [] }">✕</button>
        </div>
        <div
          v-for="f in fieldsOf(ds.id)"
          :key="f.name"
          class="tree-item"
          :class="{ sel: isPicked(ds.id, f.name) }"
          style="padding-left: 30px"
          draggable="true"
          :style="ds.id !== state.report.dataSourceId && !sectionsOf(ds.id).length ? { opacity: 0.55 } : undefined"
          :title="`[${f.name}] — drag onto a band, or double-click to add. Ctrl / Shift + click to pick several: dragged together they make a table`"
          @click="pick($event, ds.id, f.name)"
          @dragstart="onDrag($event, `[${f.name}]`, f.name, f.type, ds.id)"
          @dblclick="addToBand(`[${f.name}]`, f.name, f.type)"
        >
          <span class="field-type" :class="f.type">{{ typeLabel[f.type] }}</span>
          {{ f.name }}
        </div>
      </template>
    </template>

    <div class="panel-title" style="margin-top: 8px">
      <Calculator :size="14" /> Calculated Fields
      <button class="icon-btn" style="margin-left: auto; width: 22px; height: 22px" title="Edit calculated fields" @click="openDialog('calcFields')"><Plus :size="14" /></button>
    </div>
    <div v-if="!state.report.calculatedFields.length" class="empty-hint">None</div>
    <div
      v-for="cf in state.report.calculatedFields"
      :key="cf.id"
      class="tree-item"
      draggable="true"
      :title="cf.expression"
      @dragstart="onDrag($event, `[${cf.name}]`, cf.name, 'calc')"
      @dblclick="addToBand(`[${cf.name}]`, cf.name, 'calc')"
    >
      <span class="field-type calc">ƒx</span> {{ cf.name }}
    </div>

    <div class="panel-title" style="margin-top: 8px"><Hash :size="14" /> Special Fields</div>
    <div
      v-for="sf in specials"
      :key="sf.expr"
      class="tree-item"
      draggable="true"
      :title="sf.desc + ' — drag onto a table cell or a band'"
      @dragstart="onDragSpecial($event, sf)"
      @dblclick="addSpecial(sf)"
    >
      <span class="field-type" :class="sf.badge">{{ sf.badge === 'no' ? '#' : sf.badge }}</span> {{ sf.name }}
    </div>

    <div class="panel-title" style="margin-top: 8px">
      <Variable :size="14" /> Parameters
      <button class="icon-btn" style="margin-left: auto; width: 22px; height: 22px" title="Edit parameters" @click="openDialog('parameters')"><Plus :size="14" /></button>
    </div>
    <div v-if="!state.report.parameters.length" class="empty-hint">None</div>
    <div
      v-for="p in state.report.parameters"
      :key="p.id"
      class="tree-item"
      draggable="true"
      :title="`?${p.name}`"
      @dragstart="onDrag($event, `?${p.name}`, p.name, p.type)"
      @dblclick="addToBand(`?${p.name}`, p.name, p.type)"
    >
      <span class="field-type param">?</span> {{ p.name }} <span class="type">{{ p.type }}</span>
    </div>
  </div>
</template>

<style scoped>
.pick-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 2px 6px 4px 26px;
  padding: 4px 6px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent-soft);
  font-size: 11.5px;
}
</style>
