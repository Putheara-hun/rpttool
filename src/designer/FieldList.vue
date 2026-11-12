<script setup lang="ts">
import { computed, ref } from 'vue';
import { Calculator, ChevronDown, ChevronRight, Database, DatabaseZap, Hash, Plus, Star, Variable } from 'lucide-vue-next';
import { specialFields, type SpecialField } from './specialFields';
import { objectLabel } from '../data/dbApi';
import { addElement, dataErrors, fieldsOf, mutate, openDialog, primaryElement, rowsFor, state } from '../store/designer';
import type { FieldType } from '../model/types';

const collapsed = ref<Record<string, boolean>>({});
const sources = computed(() => state.report.dataSources);
const typeLabel: Record<FieldType, string> = { string: 'abc', number: '123', date: 'dt', boolean: 'y/n' };

function onDrag(e: DragEvent, expr: string, name: string, type: string) {
  e.dataTransfer?.setData('text/x-rt-field', JSON.stringify({ expr, name, type }));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
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
      <button class="icon-btn" style="margin-left: auto; width: 22px; height: 22px" title="Manage data sources" @click="openDialog('dataSources')"><Plus :size="14" /></button>
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
        <div
          v-for="f in fieldsOf(ds.id)"
          :key="f.name"
          class="tree-item"
          style="padding-left: 30px"
          draggable="true"
          :style="ds.id !== state.report.dataSourceId && !sectionsOf(ds.id).length ? { opacity: 0.55 } : undefined"
          :title="`[${f.name}] — drag onto a band, or double-click to add`"
          @dragstart="onDrag($event, `[${f.name}]`, f.name, f.type)"
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
