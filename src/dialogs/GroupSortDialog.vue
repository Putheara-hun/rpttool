<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, ref, toRaw } from 'vue';
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Trash2 } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import ExprInput from '../components/ExprInput.vue';
import { createElement, newBand, uid } from '../model/defaults';
import type { SortDef } from '../model/types';
import { closeDialog, fieldsOf, mutate, state } from '../store/designer';

interface LG {
  id: string;
  expression: string;
  sort: 'asc' | 'desc' | 'none';
  keepWithFirstDetail: boolean;
  footer: boolean;
  repeat: boolean;
  newPage: boolean;
  isNew: boolean;
}
const r0 = state.report;
const groups = ref<LG[]>(
  r0.groups.map((g) => {
    const h = r0.bands.find((b) => b.type === 'groupHeader' && b.groupId === g.id);
    return {
      ...g,
      footer: r0.bands.some((b) => b.type === 'groupFooter' && b.groupId === g.id),
      repeat: !!h?.repeatEveryPage,
      newPage: !!h?.pageBreakBefore,
      isNew: false,
    };
  }),
);
const sorts = ref<SortDef[]>(deepClone((r0.sort)));
const filter = ref(r0.filter);
const fields = computed(() => (r0.dataSourceId ? fieldsOf(r0.dataSourceId).map((f) => f.name) : []).concat(r0.calculatedFields.map((c) => c.name)));

function addGroup() {
  groups.value.push({ id: uid('g'), expression: fields.value[0] ? `[${fields.value[0]}]` : '', sort: 'asc', keepWithFirstDetail: true, footer: true, repeat: false, newPage: false, isNew: true });
}
function quickAdd(e: Event) {
  const sel = e.target as HTMLSelectElement;
  if (!sel.value) return;
  addGroup();
  groups.value[groups.value.length - 1].expression = `[${sel.value}]`;
  sel.value = '';
}
function move<T>(arr: T[], i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
function ok() {
  mutate((r) => {
    const keep = new Set(groups.value.map((g) => g.id));
    const dropBands = new Set(r.bands.filter((b) => b.groupId && !keep.has(b.groupId)).map((b) => b.id));
    r.groups = groups.value.map((g) => ({ id: g.id, expression: g.expression, sort: g.sort, keepWithFirstDetail: g.keepWithFirstDetail }));
    for (const g of groups.value) {
      let h = r.bands.find((b) => b.type === 'groupHeader' && b.groupId === g.id);
      if (!h) {
        h = newBand('groupHeader', g.id);
        r.bands.push(h);
        if (g.expression) {
          const el = createElement('field', h.id, 0, 4, r.elements, { expression: g.expression, width: 300, height: 22, style: { bold: true, fontSize: 11 } } as any);
          r.elements.push(el);
        }
      }
      h.repeatEveryPage = g.repeat;
      h.pageBreakBefore = g.newPage;
      const f = r.bands.find((b) => b.type === 'groupFooter' && b.groupId === g.id);
      if (g.footer && !f) r.bands.push(newBand('groupFooter', g.id));
      if (!g.footer && f) dropBands.add(f.id);
    }
    r.bands = r.bands.filter((b) => !dropBands.has(b.id));
    r.elements = r.elements.filter((e) => !dropBands.has(e.bandId));
    r.sort = deepClone((sorts.value)).filter((s) => s.expression);
    r.filter = filter.value;
  });
  closeDialog();
}
</script>

<template>
  <Modal title="Group, Sort & Filter" :width="860" @close="closeDialog">
    <template #icon><ArrowUpDown :size="16" /></template>
    <datalist id="gs-fields"><option v-for="f in fields" :key="f" :value="`[${f}]`" /></datalist>

    <div class="row"><span class="section-title" style="margin: 0">Groups</span><span class="hint">— outer group first. Each group gets a header band (and optional footer) for captions and subtotals.</span></div>
    <table class="data-table" style="margin-top: 6px">
      <thead>
        <tr>
          <th style="width: 30px">#</th>
          <th>Group by (field or expression)</th>
          <th>Sort</th>
          <th title="Show group footer band">Footer</th>
          <th title="Repeat group header on every page">Repeat</th>
          <th title="Start each group on a new page">New page</th>
          <th title="Keep the header with the first detail row">Keep</th>
          <th style="width: 90px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(g, i) in groups" :key="g.id">
          <td>{{ i + 1 }}</td>
          <td style="max-width: none"><ExprInput v-model="g.expression" title="Group expression" /></td>
          <td>
            <select v-model="g.sort"><option value="asc">Ascending</option><option value="desc">Descending</option><option value="none">None</option></select>
          </td>
          <td style="text-align: center"><input v-model="g.footer" type="checkbox" /></td>
          <td style="text-align: center"><input v-model="g.repeat" type="checkbox" /></td>
          <td style="text-align: center"><input v-model="g.newPage" type="checkbox" /></td>
          <td style="text-align: center"><input v-model="g.keepWithFirstDetail" type="checkbox" /></td>
          <td>
            <button class="icon-btn" title="Move up" @click="move(groups, i, -1)"><ArrowUp :size="13" /></button>
            <button class="icon-btn" title="Move down" @click="move(groups, i, 1)"><ArrowDown :size="13" /></button>
            <button class="icon-btn" title="Remove" @click="groups.splice(i, 1)"><Trash2 :size="13" /></button>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="row" style="margin-top: 6px">
      <button class="btn small" @click="addGroup"><Plus :size="13" /> Add group</button>
      <select style="height: 24px" @change="quickAdd">
        <option value="">Quick add: group by field…</option>
        <option v-for="f in fields" :key="f" :value="f">{{ f }}</option>
      </select>
    </div>

    <div class="section-title">Sort detail rows (after grouping)</div>
    <table class="data-table">
      <thead>
        <tr><th>Sort by</th><th style="width: 130px">Direction</th><th style="width: 90px"></th></tr>
      </thead>
      <tbody>
        <tr v-for="(s, i) in sorts" :key="s.id">
          <td style="max-width: none"><ExprInput v-model="s.expression" title="Sort expression" /></td>
          <td>
            <select v-model="s.dir"><option value="asc">Ascending</option><option value="desc">Descending</option></select>
          </td>
          <td>
            <button class="icon-btn" @click="move(sorts, i, -1)"><ArrowUp :size="13" /></button>
            <button class="icon-btn" @click="move(sorts, i, 1)"><ArrowDown :size="13" /></button>
            <button class="icon-btn" @click="sorts.splice(i, 1)"><Trash2 :size="13" /></button>
          </td>
        </tr>
      </tbody>
    </table>
    <button class="btn small" style="margin-top: 6px" @click="sorts.push({ id: uid('s'), expression: fields[0] ? `[${fields[0]}]` : '', dir: 'asc' })"><Plus :size="13" /> Add sort field</button>

    <div class="section-title">Filter</div>
    <div class="row"><ExprInput v-model="filter" title="Report filter" placeholder="e.g. [Country] = 'USA' And [Amount] > 100" /></div>
    <div class="hint" style="margin-top: 4px">Only rows for which the filter is true are printed. Use parameters (e.g. <code>[Country] = ?Country</code>) for interactive filtering.</div>

    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
