<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowDown, ArrowUp, Layers, Link2, Plus, Trash2 } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import ExprInput from '../components/ExprInput.vue';
import { deepClone } from '../model/clone';
import { newBand, uid } from '../model/defaults';
import type { DetailReportDef } from '../model/types';
import { closeDialog, fieldsOf, mutate, notify, openDialog, state } from '../store/designer';

interface Local extends DetailReportDef {
  header: boolean;
  footer: boolean;
  repeat: boolean;
  keepTogether: boolean;
}
const r0 = state.report;
const bandOf = (id: string, t: string) => r0.bands.find((b) => b.type === t && b.detailReportId === id);
const list = ref<Local[]>(
  (r0.detailReports ?? []).map((d) => ({
    ...deepClone(d),
    header: !!bandOf(d.id, 'drHeader'),
    footer: !!bandOf(d.id, 'drFooter'),
    repeat: !!bandOf(d.id, 'drHeader')?.repeatEveryPage,
    keepTogether: !!bandOf(d.id, 'drDetail')?.keepTogether,
  })),
);
const selId = ref<string | null>(state.dialogProps?.id ?? list.value[0]?.id ?? null);
const cur = computed(() => list.value.find((d) => d.id === selId.value) ?? null);

const depth = (d: Local): number => {
  let n = 0;
  let p: Local | undefined = d;
  const seen = new Set<string>();
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    n++;
    p = p.parentId ? list.value.find((x) => x.id === p!.parentId) : undefined;
  }
  return n;
};
/** order like the design surface: children right after their parent */
const ordered = computed(() => {
  const out: Local[] = [];
  const walk = (parent: string | null) => {
    for (const d of list.value.filter((x) => (x.parentId ?? null) === parent)) {
      out.push(d);
      walk(d.id);
    }
  };
  walk(null);
  for (const d of list.value) if (!out.includes(d)) out.push(d);
  return out;
});
const descendants = (id: string): Set<string> => {
  const s = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of list.value) if (d.parentId && s.has(d.parentId) && !s.has(d.id)) (s.add(d.id), (grew = true));
  }
  return s;
};
const parentChoices = computed(() => (cur.value ? list.value.filter((d) => !descendants(cur.value!.id).has(d.id)) : []));
const dsName = (id: string | null) => r0.dataSources.find((d) => d.id === id)?.name ?? '(no data source)';
const parentDs = computed(() => (cur.value?.parentId ? list.value.find((d) => d.id === cur.value!.parentId)?.dataSourceId ?? null : r0.dataSourceId));
const parentFields = computed(() => (parentDs.value ? fieldsOf(parentDs.value).map((f) => f.name) : []));
const childFields = computed(() => (cur.value?.dataSourceId ? fieldsOf(cur.value.dataSourceId).map((f) => f.name) : []));

function add(parentId: string | null = null) {
  let n = list.value.length + 1;
  while (list.value.some((d) => d.name === 'Detail Report ' + n)) n++;
  const d: Local = {
    id: uid('dr'),
    name: 'Detail Report ' + n,
    dataSourceId: r0.dataSources.find((x) => x.id !== r0.dataSourceId && !list.value.some((l) => l.dataSourceId === x.id))?.id ?? r0.dataSources[0]?.id ?? null,
    parentId,
    printMode: parentId ? 'perRow' : 'once',
    keys: [],
    filter: '',
    sort: [],
    header: true,
    footer: false,
    repeat: true,
    keepTogether: false,
  };
  list.value.push(d);
  selId.value = d.id;
}
function remove() {
  if (!cur.value) return;
  const gone = descendants(cur.value.id);
  list.value = list.value.filter((d) => !gone.has(d.id));
  selId.value = list.value[0]?.id ?? null;
}
function autoLink() {
  const d = cur.value;
  if (!d) return;
  const common = parentFields.value.filter((f) => childFields.value.some((c) => c.toLowerCase() === f.toLowerCase()));
  if (!common.length) return notify('No field with the same name in both data sources — choose the fields manually', 'error');
  const pick = common.find((f) => /id$|code$|_no$|key$/i.test(f)) ?? common[0];
  d.keys = [{ master: pick, child: childFields.value.find((c) => c.toLowerCase() === pick.toLowerCase())! }];
}
function move<T>(arr: T[], i: number, dlt: number) {
  const j = i + dlt;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function valid() {
  for (const d of list.value) {
    if (!d.name.trim()) return notify('Every section needs a name', 'error'), false;
    if (!d.dataSourceId) return notify(`Choose a data source for "${d.name}"`, 'error'), false;
  }
  return true;
}
function toDataSources() {
  if (!r0.dataSources.length || valid()) {
    if (list.value.length) ok();
    openDialog('dataSources');
  }
}
function ok() {
  if (!valid()) return;
  mutate((r) => {
    const keep = new Set(list.value.map((d) => d.id));
    const dropped = new Set(r.bands.filter((b) => b.detailReportId && !keep.has(b.detailReportId)).map((b) => b.id));
    r.detailReports = list.value.map(({ header, footer, repeat, keepTogether, ...d }) => ({
      ...deepClone(d),
      keys: d.keys.filter((k) => k.master && k.child),
      sort: d.sort.filter((s) => s.expression),
    }));
    for (const d of list.value) {
      const has = (t: 'drHeader' | 'drDetail' | 'drFooter') => r.bands.find((b) => b.type === t && b.detailReportId === d.id);
      if (!has('drDetail')) r.bands.push(newBand('drDetail', d.id));
      const h = has('drHeader');
      if (d.header && !h) r.bands.push({ ...newBand('drHeader', d.id), repeatEveryPage: d.repeat });
      if (!d.header && h) dropped.add(h.id);
      if (h) h.repeatEveryPage = d.repeat;
      const f = has('drFooter');
      if (d.footer && !f) r.bands.push(newBand('drFooter', d.id));
      if (!d.footer && f) dropped.add(f.id);
      const det = has('drDetail');
      if (det) det.keepTogether = d.keepTogether;
    }
    r.bands = r.bands.filter((b) => !dropped.has(b.id));
    r.elements = r.elements.filter((e) => !dropped.has(e.bandId));
  });
  closeDialog();
}
</script>

<template>
  <Modal title="Detail Reports (sections)" :width="1000" :height="660" @close="closeDialog">
    <template #icon><Layers :size="16" /></template>
    <div class="split" style="height: 100%">
      <div class="col" style="width: 250px; min-width: 250px">
        <div class="list-box" style="flex: 1">
          <div class="list-row" style="cursor: default; color: var(--muted)"><b>Main report</b>&nbsp;· {{ dsName(r0.dataSourceId) }}</div>
          <div v-for="d in ordered" :key="d.id" class="list-row" :class="{ sel: d.id === selId }" :style="{ paddingLeft: 10 + depth(d) * 14 + 'px' }" @click="selId = d.id">
            <Layers :size="13" />
            <span class="grow" style="overflow: hidden; text-overflow: ellipsis">{{ d.name }}</span>
            <span class="hint">{{ d.printMode === 'perRow' ? 'per row' : 'once' }}</span>
          </div>
          <div v-if="!list.length" class="empty-hint">
            A <b>detail report</b> is an extra section with its <b>own data source</b>, its own header and its own repeating rows.<br /><br />
            Use it to print several lists in one report, or master–detail (e.g. each employee followed by his loans).
          </div>
        </div>
        <button class="btn primary" @click="add(null)"><Plus :size="14" /> Add section</button>
        <button class="btn" :disabled="!cur" @click="add(cur!.id)"><Plus :size="14" /> Add nested section</button>
        <button class="btn danger" :disabled="!cur" @click="remove"><Trash2 :size="14" /> Remove</button>
      </div>

      <div v-if="cur" class="col" style="flex: 1; min-width: 0; overflow: auto; padding-right: 4px">
        <div class="form-grid" style="grid-template-columns: 150px 1fr">
          <label>Name</label>
          <input v-model="cur.name" />
          <label>Data source</label>
          <div class="row">
            <select v-model="cur.dataSourceId" style="flex: 1">
              <option :value="null" disabled>— choose —</option>
              <option v-for="ds in r0.dataSources" :key="ds.id" :value="ds.id">{{ ds.name }}{{ ds.id === r0.dataSourceId ? ' (main)' : '' }}</option>
            </select>
            <button class="btn small" title="Add or edit data sources (saves this dialog first)" @click="toDataSources">Data sources…</button>
          </div>
          <label>Placed under</label>
          <select v-model="cur.parentId">
            <option :value="null">Main report</option>
            <option v-for="d in parentChoices" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
          <label>Print</label>
          <div class="col" style="gap: 4px">
            <label class="row"><input v-model="cur.printMode" type="radio" value="once" /> <b>Once</b>&nbsp;— after all rows of {{ cur.parentId ? 'the parent section' : 'the main report' }} (independent list)</label>
            <label class="row"><input v-model="cur.printMode" type="radio" value="perRow" /> <b>For every {{ cur.parentId ? 'parent' : 'main' }} row</b>&nbsp;— master–detail</label>
          </div>
        </div>

        <template v-if="cur.printMode === 'perRow'">
          <div class="section-title"><Link2 :size="13" /> Link fields (parent = this section)</div>
          <table class="data-table">
            <thead>
              <tr><th>Parent field ({{ dsName(parentDs) }})</th><th style="width: 20px"></th><th>Field in {{ dsName(cur.dataSourceId) }}</th><th style="width: 40px"></th></tr>
            </thead>
            <tbody>
              <tr v-for="(k, i) in cur.keys" :key="i">
                <td style="max-width: none">
                  <input v-model="k.master" list="dr-parent-fields" style="width: 100%" />
                </td>
                <td style="text-align: center">=</td>
                <td style="max-width: none"><input v-model="k.child" list="dr-child-fields" style="width: 100%" /></td>
                <td><button class="icon-btn" @click="cur.keys.splice(i, 1)"><Trash2 :size="13" /></button></td>
              </tr>
            </tbody>
          </table>
          <datalist id="dr-parent-fields"><option v-for="f in parentFields" :key="f" :value="f" /></datalist>
          <datalist id="dr-child-fields"><option v-for="f in childFields" :key="f" :value="f" /></datalist>
          <div class="row" style="margin-top: 6px">
            <button class="btn small" @click="cur.keys.push({ master: parentFields[0] ?? '', child: childFields[0] ?? '' })"><Plus :size="12" /> Add key</button>
            <button class="btn small" @click="autoLink">Link by same field name</button>
            <span class="hint">No key = every parent row shows all rows (use the filter below for other conditions).</span>
          </div>
        </template>

        <div class="section-title">Filter</div>
        <div class="row"><ExprInput v-model="cur.filter" title="Section filter" placeholder="e.g. [AMOUNT] > 0 And [BCCY] = [Master.BCCY] And [DATE] <= ?DATE" /></div>
        <div class="hint" style="margin-top: 3px">
          Use any condition. <code>[Field]</code> = this section's row, <code>[Master.Field]</code> = the parent row, <code>?Param</code> = report parameter.
        </div>

        <div class="section-title">Sort rows</div>
        <table v-if="cur.sort.length" class="data-table">
          <tbody>
            <tr v-for="(s, i) in cur.sort" :key="s.id">
              <td style="max-width: none"><ExprInput v-model="s.expression" title="Sort expression" /></td>
              <td style="width: 120px">
                <select v-model="s.dir"><option value="asc">Ascending</option><option value="desc">Descending</option></select>
              </td>
              <td style="width: 90px">
                <button class="icon-btn" @click="move(cur.sort, i, -1)"><ArrowUp :size="13" /></button>
                <button class="icon-btn" @click="move(cur.sort, i, 1)"><ArrowDown :size="13" /></button>
                <button class="icon-btn" @click="cur.sort.splice(i, 1)"><Trash2 :size="13" /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="row" style="margin-top: 4px">
          <button class="btn small" @click="cur.sort.push({ id: uid('s'), expression: childFields[0] ? `[${childFields[0]}]` : '', dir: 'asc' })"><Plus :size="12" /> Add sort</button>
        </div>

        <div class="section-title">Bands</div>
        <div class="col" style="gap: 4px">
          <label class="row"><input v-model="cur.header" type="checkbox" /> Header band (column captions, printed once above the rows)</label>
          <label class="row" style="padding-left: 22px"><input v-model="cur.repeat" type="checkbox" :disabled="!cur.header" /> Repeat the header on every page</label>
          <label class="row"><input v-model="cur.footer" type="checkbox" /> Footer band (totals such as <code>Sum([AMOUNT])</code> over this section's rows)</label>
          <label class="row"><input v-model="cur.keepTogether" type="checkbox" /> Keep each row together (no split across pages)</label>
        </div>
      </div>
      <div v-else class="empty-hint" style="flex: 1">Click <b>Add section</b> to create a detail report.</div>
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
