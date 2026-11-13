<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, nextTick, ref, toRaw, watch } from 'vue';
import { Database, DatabaseZap, Plus, Star, Trash2, Upload } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import SqlSourceEditor from './SqlSourceEditor.vue';
import type { DataSourceDef, FieldType, Row } from '../model/types';
import { uid } from '../model/defaults';
import { SAMPLE_SETS } from '../data/sampleData';
import { coerceRows, inferFields, loadDataSource, loadDataSourceSync } from '../data/dataSource';
import { DbError, executeSql, fieldsFromResult, providerLabel, resolveSqlParams } from '../data/dbApi';
import { closeDialog, dataCache, dataParamCtx, ensureData, mutate, notify, requestLogin, requestReconnect, state } from '../store/designer';
import { defaultToString } from '../engine/format';

const list = ref<DataSourceDef[]>(deepClone((state.report.dataSources)));
const mainId = ref<string | null>(state.report.dataSourceId);
const selId = ref<string | null>(list.value[0]?.id ?? null);
const cur = computed(() => list.value.find((d) => d.id === selId.value) ?? null);
const previewRows = ref<Row[]>([]);
const previewErr = ref('');
const previewInfo = ref('');
const loading = ref(false);
const addOpen = ref(false);
const isSql = computed(() => cur.value?.kind === 'sql');

const newSql = () => ({ connectionId: '', mode: 'table' as const, params: [], maxRows: 100000 });
function add(kind: DataSourceDef['kind']) {
  addOpen.value = false;
  const base: DataSourceDef = { id: uid('ds'), name: 'DataSource' + (list.value.length + 1), kind, fields: [] };
  if (kind === 'sql') Object.assign(base, { name: 'Database' + (list.value.filter((d) => d.kind === 'sql').length + 1), sql: newSql() });
  if (kind === 'sample') Object.assign(base, { sample: 'orders', name: 'Orders' });
  if (kind === 'json') base.content = '[\n  { "Name": "Alpha", "Value": 10, "Date": "2025-01-15" },\n  { "Name": "Beta", "Value": 25, "Date": "2025-02-03" }\n]';
  if (kind === 'csv') base.content = 'Name,Value,Date\nAlpha,10,2025-01-15\nBeta,25,2025-02-03';
  if (kind === 'url') base.url = 'https://';
  list.value.push(base);
  selId.value = base.id;
  if (!mainId.value) mainId.value = base.id;
  if (kind !== 'sql') void refresh(true);
  else previewRows.value = [];
}
function onKindChange() {
  if (cur.value?.kind === 'sql' && !cur.value.sql) cur.value.sql = newSql();
  void refresh(true);
}
/** from the "no database on this website" notice: same data source, rows pasted as CSV / JSON instead */
const contentBox = ref<HTMLTextAreaElement>();
function switchKind(kind: 'json' | 'csv') {
  const ds = cur.value;
  if (!ds) return;
  ds.kind = kind;
  ds.content = '';
  ds.fields = [];
  previewErr.value = '';
  previewRows.value = [];
  void nextTick(() => contentBox.value?.focus());
}
/** pasted rows: read them right away (the text lands in the box after the paste event) */
const afterPaste = () => setTimeout(() => void refresh(true), 0);
const contentPlaceholder = computed(() =>
  cur.value?.kind === 'csv'
    ? 'Paste rows here — first line = column names.\nFrom SQL Server Management Studio: right-click the results → Copy with Headers, then paste (Ctrl+V).\n\nName,Value,Date\nAlpha,10,2025-01-15'
    : 'Paste a JSON array of rows here, e.g.\n[\n  { "Name": "Alpha", "Value": 10, "Date": "2025-01-15" }\n]',
);
function remove() {
  if (!cur.value) return;
  const id = cur.value.id;
  list.value = list.value.filter((d) => d.id !== id);
  if (mainId.value === id) mainId.value = list.value[0]?.id ?? null;
  selId.value = list.value[0]?.id ?? null;
}

/** Run the database source (first 200 rows) to get its fields and a preview; asks for a login when needed. */
async function previewSql(ds: DataSourceDef, detect: boolean) {
  const s = ds.sql;
  if (!s?.connectionId || (s.mode === 'query' ? !s.query?.trim() : !s.name)) return;
  const run = () => {
    const raw = deepClone(s);
    return executeSql(raw, resolveSqlParams(raw, dataParamCtx()), 200);
  };
  let r;
  try {
    r = await run();
  } catch (e) {
    if (e instanceof DbError && e.needLogin && e.connectionId && (await requestLogin(e.connectionId, e.connectionName ?? s.connectionName ?? ''))) r = await run();
    else if (e instanceof DbError && (e.authFailed || e.missingConnection)) {
      // the login was refused / the connection is gone: ask for server, user and password again
      const c = await requestReconnect({ connectionId: s.connectionId, connectionName: s.connectionName, reason: e.message, dataSource: ds.name, missing: e.missingConnection });
      if (!c?.id) throw e;
      s.connectionId = c.id;
      s.connectionName = c.name;
      r = await run();
    } else throw e;
  }
  const fields = fieldsFromResult(r, inferFields);
  if (detect || !ds.fields.length || fields.map((f) => f.name).join() !== ds.fields.map((f) => f.name).join()) ds.fields = fields;
  previewRows.value = coerceRows(r.rows, ds.fields);
  previewInfo.value = `${r.rows.length}${r.truncated ? '+' : ''} rows · ${r.ms} ms`;
}

async function refresh(detect = false) {
  const ds = cur.value;
  previewErr.value = '';
  previewInfo.value = '';
  previewRows.value = [];
  if (!ds) return;
  loading.value = true;
  try {
    if (ds.kind === 'sql') return await previewSql(ds, detect);
    const raw = deepClone((ds));
    if (detect) raw.fields = [];
    const rows = loadDataSourceSync(raw) ?? (await loadDataSource(raw));
    previewRows.value = rows;
    if (detect || !ds.fields.length) ds.fields = inferFields(rows);
  } catch (e) {
    previewErr.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
watch(selId, () => refresh(false), { immediate: true });

function loadFile() {
  const ds = cur.value;
  if (!ds) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,.csv,.txt,application/json,text/csv';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    ds.content = await f.text();
    ds.kind = /\.csv$|\.txt$/i.test(f.name) ? 'csv' : 'json';
    if (/^DataSource\d+$/.test(ds.name)) ds.name = f.name.replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_');
    await refresh(true);
  };
  inp.click();
}

const cols = computed(() => (previewRows.value.length ? Object.keys(previewRows.value[0]) : (cur.value?.fields ?? []).map((f) => f.name)));
const cell = (v: unknown) => defaultToString(v);

function ok() {
  const names = new Set<string>();
  for (const d of list.value) {
    if (!d.name.trim()) return notify('Every data source needs a name', 'error');
    if (names.has(d.name)) return notify('Duplicate data source name: ' + d.name, 'error');
    if (d.kind === 'sql' && !d.sql?.connectionId) return notify(`Choose a database connection for "${d.name}"`, 'error');
    names.add(d.name);
  }
  mutate((r) => {
    r.dataSources = deepClone((list.value));
    r.dataSourceId = mainId.value;
  });
  for (const k of Object.keys(dataCache)) delete dataCache[k];
  void ensureData(true);
  closeDialog();
}
const FIELD_TYPES: FieldType[] = ['string', 'number', 'date', 'boolean'];
</script>

<template>
  <Modal title="Data Sources" :width="isSql ? 1180 : 980" :height="isSql ? 860 : 640" @close="closeDialog">
    <template #icon><Database :size="16" /></template>
    <div class="split" style="height: 100%">
      <div class="col" style="width: 220px; min-width: 220px">
        <div class="list-box" style="flex: 1">
          <div v-for="d in list" :key="d.id" class="list-row" :class="{ sel: d.id === selId }" @click="selId = d.id">
            <component :is="d.kind === 'sql' ? DatabaseZap : Database" :size="14" />
            <span class="grow" style="overflow: hidden; text-overflow: ellipsis">{{ d.name }}</span>
            <Star v-if="d.id === mainId" :size="12" fill="#f59e0b" color="#f59e0b" />
            <span class="hint">{{ d.kind === 'sql' ? 'database' : d.kind }}</span>
          </div>
          <div v-if="!list.length" class="empty-hint">No data sources yet. Click <b>Add data source</b> and choose <b>Database</b> to connect to SQL Server, Oracle, PostgreSQL, MySQL or SQLite.</div>
        </div>
        <div class="dropdown">
          <button class="btn primary" style="width: 100%" @click="addOpen = !addOpen"><Plus :size="14" /> Add data source</button>
          <div v-if="addOpen" class="dropdown-menu" style="bottom: 100%; top: auto; min-width: 260px">
            <button class="menu-item" @click="add('sql')"><DatabaseZap :size="14" /> <b>Database</b>&nbsp;(SQL Server, Oracle, PostgreSQL, MySQL…)</button>
            <div class="menu-sep" />
            <button class="menu-item" @click="add('sample')">Sample data set</button>
            <button class="menu-item" @click="add('json')">JSON (paste or file)</button>
            <button class="menu-item" @click="add('csv')">CSV (paste or file)</button>
            <button class="menu-item" @click="add('url')">Web URL (JSON / CSV)</button>
          </div>
        </div>
      </div>

      <div v-if="cur" class="col" style="flex: 1; min-width: 0">
        <div class="form-grid">
          <label>Name</label>
          <input v-model="cur.name" />
          <label>Type</label>
          <div class="row">
            <select v-model="cur.kind" @change="onKindChange">
              <option value="sql">Database (SQL)</option>
              <option value="sample">Sample data set</option>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="url">Web URL</option>
            </select>
            <label class="row" style="margin-left: 12px"><input type="radio" :checked="mainId === cur.id" @change="mainId = cur!.id" /> Report data source</label>
            <span class="grow" />
            <button class="btn danger small" @click="remove"><Trash2 :size="13" /> Remove</button>
          </div>
          <template v-if="cur.kind === 'sample'">
            <label>Data set</label>
            <select v-model="cur.sample" @change="refresh(true)">
              <option v-for="(s, k) in SAMPLE_SETS" :key="k" :value="k">{{ s.label }}</option>
            </select>
          </template>
          <template v-if="cur.kind === 'url'">
            <label>URL</label>
            <input v-model="cur.url" placeholder="https://example.com/data.json" @change="refresh(true)" />
          </template>
          <template v-if="cur.kind === 'json' || cur.kind === 'url'">
            <label>Array path</label>
            <input v-model="cur.path" placeholder="optional, e.g. data.items" @change="refresh(true)" />
          </template>
        </div>
        <template v-if="cur.kind === 'json' || cur.kind === 'csv'">
          <div class="row">
            <span class="section-title" style="margin: 0">{{ cur.kind.toUpperCase() }} content</span>
            <span class="grow" />
            <button class="btn small" @click="loadFile"><Upload :size="13" /> Load file…</button>
            <button class="btn small" @click="refresh(true)">Parse</button>
          </div>
          <textarea
            ref="contentBox"
            v-model="cur.content"
            style="height: 120px; font-family: Consolas, monospace; font-size: 12px"
            spellcheck="false"
            :placeholder="contentPlaceholder"
            @change="refresh(true)"
            @paste="afterPaste"
          />
        </template>
        <SqlSourceEditor v-if="cur.kind === 'sql' && cur.sql" :key="cur.id" :source="cur.sql" @preview="refresh(true)" @switch-kind="switchKind" />
        <div v-if="previewErr" class="err" style="word-break: break-word">{{ previewErr }}</div>

        <div class="split" style="flex: 1; min-height: 0">
          <div class="col" style="width: 250px">
            <div class="row">
              <span class="section-title" style="margin: 0">Fields ({{ cur.fields.length }})</span>
              <span class="grow" />
              <button class="btn small" @click="refresh(true)">Detect</button>
            </div>
            <div class="list-box" style="flex: 1">
              <div v-for="f in cur.fields" :key="f.name" class="list-row" style="padding: 3px 8px">
                <span class="grow" style="overflow: hidden; text-overflow: ellipsis">{{ f.name }}</span>
                <select v-model="f.type" style="height: 22px; font-size: 11px">
                  <option v-for="t in FIELD_TYPES" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
            </div>
          </div>
          <div class="col" style="flex: 1; min-width: 0">
            <span class="section-title" style="margin: 0"
              >Preview ({{ loading ? 'loading…' : previewInfo || previewRows.length + ' rows' }}){{ isSql && cur.sql?.connectionName ? ' — ' + cur.sql.connectionName : '' }}</span
            >
            <div class="list-box" style="flex: 1">
              <table class="data-table">
                <thead>
                  <tr><th v-for="c in cols" :key="c">{{ c }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in previewRows.slice(0, 50)" :key="i">
                    <td v-for="c in cols" :key="c" :title="cell(r[c])">{{ cell(r[c]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint" style="flex: 1">
        Add a data source to bind your report to data.<br /><br />
        <button class="btn primary" @click="add('sql')"><DatabaseZap :size="14" /> Connect to a database</button>
        <p>Log in to SQL Server, Oracle, PostgreSQL, MySQL / MariaDB or a SQLite file, then pick a table, view, stored procedure, function — or write your own SQL query.</p>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
