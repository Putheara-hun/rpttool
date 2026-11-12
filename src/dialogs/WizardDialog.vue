<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, ref, toRaw, watch } from 'vue';
import { ArrowDown, ArrowUp, WandSparkles } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { SAMPLE_SETS } from '../data/sampleData';
import { inferFields } from '../data/dataSource';
import { buildWizardReport } from '../wizard/reportBuilder';
import { PAPER_SIZES } from '../model/defaults';
import type { SummaryFunc } from '../model/types';
import { closeDialog, fieldsOf, loadReport, state } from '../store/designer';

const STEPS = ['Data source', 'Fields', 'Grouping', 'Summaries', 'Layout & style'];
const step = ref(0);
const source = ref(state.report.dataSourceId ? 'ds:' + state.report.dataSourceId : 'sample:orders');
const available = computed(() => {
  const [kind, key] = source.value.split(':');
  if (kind === 'ds') return fieldsOf(key);
  return inferFields(SAMPLE_SETS[key]?.load() ?? []);
});
const chosen = ref<string[]>([]);
watch(
  available,
  (f) => {
    chosen.value = f.slice(0, 6).map((x) => x.name);
    groups.value = [];
    summaries.value = {};
  },
  { immediate: false },
);
const groups = ref<string[]>([]);
const summaries = ref<Record<string, SummaryFunc[]>>({});
const title = ref('New Report');
const landscape = ref(false);
const paper = ref('A4');
const theme = ref<'blue' | 'gray' | 'green' | 'orange'>('blue');
const zebra = ref(true);
const chart = ref(true);
chosen.value = available.value.slice(0, 6).map((x) => x.name);

const typeOf = (n: string) => available.value.find((f) => f.name === n)?.type ?? 'string';
const numericChosen = computed(() => chosen.value.filter((n) => typeOf(n) === 'number' && !groups.value.includes(n)));
function toggleField(n: string) {
  const i = chosen.value.indexOf(n);
  if (i >= 0) chosen.value.splice(i, 1);
  else chosen.value.push(n);
}
function move(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= chosen.value.length) return;
  const a = chosen.value;
  [a[i], a[j]] = [a[j], a[i]];
}
function toggleSum(field: string, fn: SummaryFunc) {
  const list = summaries.value[field] ?? [];
  summaries.value[field] = list.includes(fn) ? list.filter((x) => x !== fn) : [...list, fn];
}
function setGroup(i: number, v: string) {
  const g = [...groups.value];
  if (v) g[i] = v;
  else g.splice(i);
  groups.value = g.filter(Boolean);
}
function finish() {
  if (state.dirty && !confirm('Replace the current report with the wizard result?')) return;
  const [kind, key] = source.value.split(':');
  const ds = kind === 'ds' ? state.report.dataSources.find((d) => d.id === key) : undefined;
  const r = buildWizardReport({
    title: title.value,
    sample: kind === 'sample' ? key : undefined,
    dataSource: ds ? (deepClone((ds)) as any) : undefined,
    fields: chosen.value.map((n) => ({ name: n, type: typeOf(n) })),
    groups: groups.value,
    summaries: Object.fromEntries(Object.entries(summaries.value).filter(([k]) => numericChosen.value.includes(k))),
    paper: paper.value,
    landscape: landscape.value,
    theme: theme.value,
    zebra: zebra.value,
    chart: chart.value,
  });
  loadReport(r, (title.value || 'report').replace(/\W+/g, '-').toLowerCase() + '.rptx');
  closeDialog();
}
</script>

<template>
  <Modal title="Report Wizard" :width="720" :height="560" @close="closeDialog">
    <template #icon><WandSparkles :size="16" /></template>
    <div class="wizard-steps">
      <div v-for="(s, i) in STEPS" :key="s" :class="{ on: i === step, done: i < step }">{{ i + 1 }}. {{ s }}</div>
    </div>

    <div v-if="step === 0" class="col">
      <div class="section-title" style="margin-top: 0">Choose the data to report on</div>
      <label v-for="ds in state.report.dataSources" :key="ds.id" class="list-row" style="border: 1px solid var(--border); border-radius: 6px">
        <input v-model="source" type="radio" :value="'ds:' + ds.id" /> <b>{{ ds.name }}</b> <span class="hint">(current report data source)</span>
      </label>
      <label v-for="(s, k) in SAMPLE_SETS" :key="k" class="list-row" style="border: 1px solid var(--border); border-radius: 6px">
        <input v-model="source" type="radio" :value="'sample:' + k" /> {{ s.label }} <span class="hint">sample data</span>
      </label>
      <div class="hint">To use your own JSON / CSV data, add it first under Report → Data Sources, then run the wizard.</div>
    </div>

    <div v-else-if="step === 1" class="split" style="height: 330px">
      <div class="col" style="flex: 1">
        <div class="section-title" style="margin-top: 0">Available fields</div>
        <div class="list-box" style="flex: 1">
          <label v-for="f in available" :key="f.name" class="list-row"><input type="checkbox" :checked="chosen.includes(f.name)" @change="toggleField(f.name)" /> {{ f.name }} <span class="grow" /><span class="hint">{{ f.type }}</span></label>
        </div>
      </div>
      <div class="col" style="flex: 1">
        <div class="section-title" style="margin-top: 0">Column order</div>
        <div class="list-box" style="flex: 1">
          <div v-for="(n, i) in chosen" :key="n" class="list-row">
            {{ i + 1 }}. {{ n }} <span class="grow" />
            <button class="icon-btn" @click="move(i, -1)"><ArrowUp :size="13" /></button>
            <button class="icon-btn" @click="move(i, 1)"><ArrowDown :size="13" /></button>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="step === 2" class="form-grid">
      <label>Group by</label>
      <select :value="groups[0] ?? ''" @change="setGroup(0, ($event.target as HTMLSelectElement).value)">
        <option value="">(no grouping)</option>
        <option v-for="n in chosen" :key="n" :value="n">{{ n }}</option>
      </select>
      <template v-if="groups[0]">
        <label>Then by</label>
        <select :value="groups[1] ?? ''" @change="setGroup(1, ($event.target as HTMLSelectElement).value)">
          <option value="">(none)</option>
          <option v-for="n in chosen.filter((x) => x !== groups[0])" :key="n" :value="n">{{ n }}</option>
        </select>
      </template>
      <label />
      <div class="hint">Grouped fields become group headers instead of columns. Rows are sorted by the group fields.</div>
    </div>

    <div v-else-if="step === 3">
      <div class="section-title" style="margin-top: 0">Totals for numeric columns{{ groups.length ? ' (per group and grand total)' : ' (grand total)' }}</div>
      <table v-if="numericChosen.length" class="data-table">
        <thead>
          <tr><th>Field</th><th v-for="fn in ['sum', 'avg', 'min', 'max', 'count']" :key="fn">{{ fn }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="n in numericChosen" :key="n">
            <td>{{ n }}</td>
            <td v-for="fn in ['sum', 'avg', 'min', 'max', 'count'] as SummaryFunc[]" :key="fn" style="text-align: center">
              <input type="checkbox" :checked="(summaries[n] ?? []).includes(fn)" @change="toggleSum(n, fn)" />
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-hint">No numeric columns selected.</div>
    </div>

    <div v-else class="form-grid">
      <label>Report title</label>
      <input v-model="title" />
      <label>Paper size</label>
      <select v-model="paper">
        <option v-for="(s, k) in PAPER_SIZES" :key="k" :value="k">{{ s.label }}</option>
      </select>
      <label>Orientation</label>
      <div class="row">
        <label class="row"><input v-model="landscape" type="radio" :value="false" /> Portrait</label>
        <label class="row"><input v-model="landscape" type="radio" :value="true" /> Landscape</label>
      </div>
      <label>Color theme</label>
      <div class="row">
        <label v-for="(c, k) in { blue: '#1e3a8a', gray: '#374151', green: '#166534', orange: '#9a3412' }" :key="k" class="row" style="margin-right: 10px">
          <input v-model="theme" type="radio" :value="k" /><span :style="{ width: '18px', height: '18px', background: c, borderRadius: '4px', display: 'inline-block' }" />
        </label>
      </div>
      <label>Options</label>
      <div class="col">
        <label class="row"><input v-model="zebra" type="checkbox" /> Alternate row colors</label>
        <label class="row"><input v-model="chart" type="checkbox" :disabled="!groups.length" /> Add a chart of the first numeric column by group</label>
      </div>
    </div>

    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <span class="grow" />
      <button class="btn" :disabled="step === 0" @click="step--">Back</button>
      <button v-if="step < STEPS.length - 1" class="btn primary" :disabled="step === 1 && !chosen.length" @click="step++">Next</button>
      <button v-else class="btn primary" :disabled="!chosen.length" @click="finish">Finish</button>
    </template>
  </Modal>
</template>
