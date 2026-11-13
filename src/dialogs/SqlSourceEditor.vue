<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  CodeXml,
  DatabaseZap,
  Eye,
  SquareFunction,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sheet,
  Table,
  Trash2,
  Variable,
  Workflow,
} from 'lucide-vue-next';
import ExprInput from '../components/ExprInput.vue';
import ConnectionDialog from './ConnectionDialog.vue';
import type { ParamType, SqlMode, SqlParam, SqlSource } from '../model/types';
import { uid } from '../model/defaults';
import {
  DbError,
  deleteConnection,
  detectQueryParams,
  getRoutineParams,
  getSchema,
  listConnections,
  objectLabel,
  providerLabel,
  serverHealth,
  signOut,
  type DbConnection,
  type DbObject,
  type DbSchema,
} from '../data/dbApi';
import { mutate, notify, requestLogin, requestReconnect, state } from '../store/designer';

const props = defineProps<{ source: SqlSource }>();
const emit = defineEmits<{ preview: []; switchKind: [kind: 'json' | 'csv'] }>();
const src = props.source;

const connections = ref<DbConnection[]>([]);
const schema = ref<DbSchema | null>(null);
const loadingSchema = ref(false);
const error = ref('');
const search = ref('');
const open = ref<Record<string, boolean>>({ tables: true, views: true, procedures: true, functions: true });
const connDialog = ref<{ conn: DbConnection | null } | null>(null);
const current = computed(() => connections.value.find((c) => c.id === src.connectionId) ?? null);

async function withLogin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DbError && e.needLogin && e.connectionId) {
      if (await requestLogin(e.connectionId, e.connectionName ?? current.value?.name ?? '')) {
        await loadConnections();
        return await fn();
      }
    }
    // the login was refused / the connection is gone: ask for server, user and password again
    if (e instanceof DbError && (e.authFailed || e.missingConnection) && src.connectionId) {
      const c = await requestReconnect({ connectionId: src.connectionId, connectionName: src.connectionName ?? current.value?.name, reason: e.message, dataSource: '', missing: e.missingConnection });
      if (c?.id) {
        src.connectionId = c.id;
        src.connectionName = c.name;
        await loadConnections();
        return await fn();
      }
    }
    throw e;
  }
}

/** no ReportTool server on this website (static hosting): no database connections possible */
const noService = ref(false);
/** the server has a team password and the sign-in was cancelled */
const needSignIn = ref(false);
/** signed in with the team password (offer "Sign out") */
const signedIn = ref(false);
async function loadConnections(): Promise<boolean> {
  try {
    connections.value = await listConnections();
    error.value = '';
    noService.value = false;
    needSignIn.value = false;
    return true;
  } catch (e) {
    error.value = (e as Error).message;
    noService.value = e instanceof DbError && !!e.noService;
    needSignIn.value = e instanceof DbError && !!e.authRequired;
    return false;
  }
}
async function refreshAuth() {
  const h = await serverHealth().catch(() => null);
  signedIn.value = !!(h?.auth && h.signedIn);
}
async function signInAgain() {
  if ((await loadConnections()) && src.connectionId && current.value) await loadSchema();
  await refreshAuth();
}
async function doSignOut() {
  await signOut().catch(() => undefined);
  connections.value = [];
  schema.value = null;
  signedIn.value = false;
  needSignIn.value = true;
  error.value = 'Signed out. Sign in again to use database connections.';
}
async function loadSchema() {
  schema.value = null;
  if (!src.connectionId) return;
  loadingSchema.value = true;
  error.value = '';
  try {
    schema.value = await withLogin(() => getSchema(src.connectionId));
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loadingSchema.value = false;
  }
}
function pickConnection(id: string) {
  src.connectionId = id;
  src.connectionName = connections.value.find((c) => c.id === id)?.name;
  void loadSchema();
}
async function onSaved(c: DbConnection) {
  connDialog.value = null;
  await loadConnections();
  pickConnection(c.id!);
}
async function removeConnection() {
  const c = current.value;
  if (!c || !confirm(`Delete the connection "${c.name}"? Reports that use it will ask for another connection.`)) return;
  await deleteConnection(c.id!);
  src.connectionId = '';
  schema.value = null;
  await loadConnections();
}
async function login() {
  const c = current.value;
  if (c && (await requestLogin(c.id!, c.name))) {
    await loadConnections();
    await loadSchema();
  }
}

type Kind = 'tables' | 'views' | 'procedures' | 'functions';
const KINDS: { key: Kind; label: string; mode: SqlMode; icon: any }[] = [
  { key: 'tables', label: 'Tables', mode: 'table', icon: Table },
  { key: 'views', label: 'Views', mode: 'view', icon: Eye },
  { key: 'procedures', label: 'Stored Procedures', mode: 'procedure', icon: Workflow },
  { key: 'functions', label: 'Functions', mode: 'function', icon: SquareFunction },
];
const fullName = (o: DbObject) => [o.schema, o.pkg, o.name].filter(Boolean).join('.');
const filtered = (k: Kind) => {
  const q = search.value.trim().toLowerCase();
  const list = schema.value?.[k] ?? [];
  return q ? list.filter((o) => fullName(o).toLowerCase().includes(q)) : list;
};
const isSel = (k: Kind, o: DbObject) => {
  const mode = KINDS.find((x) => x.key === k)!.mode;
  return src.mode === mode && src.name === o.name && (src.schema ?? '') === (o.schema ?? '') && (src.pkg ?? '') === (o.pkg ?? '') && (src.specific ?? '') === (o.specific ?? '');
};

const reportParamFor = (name: string) => state.report.parameters.find((p) => p.name.toLowerCase() === name.toLowerCase());
function defaultValue(name: string, prev?: SqlParam) {
  if (prev?.value) return prev.value;
  const rp = reportParamFor(name);
  return rp ? `?${rp.name}` : '';
}

async function choose(k: Kind, o: DbObject) {
  const mode = KINDS.find((x) => x.key === k)!.mode;
  const prev = new Map(src.params.map((p) => [p.name.toLowerCase(), p]));
  Object.assign(src, { mode, schema: o.schema, name: o.name, pkg: o.pkg, specific: o.specific, returnsTable: o.returnsTable, returnType: o.returnType, query: src.query });
  src.params = [];
  if (mode === 'procedure' || mode === 'function') {
    try {
      const r = await withLogin(() => getRoutineParams(src.connectionId, o));
      if (r.returnType) src.returnType = r.returnType;
      src.params = r.params.map((p) => ({ name: p.name, type: p.type, dbType: p.dbType, mode: p.mode, value: p.mode === 'OUT' ? '' : defaultValue(p.name, prev.get(p.name.toLowerCase())) }));
    } catch (e) {
      error.value = (e as Error).message;
      return;
    }
  }
  if (!src.params.some((p) => p.mode !== 'OUT' && !p.value)) emit('preview');
}

function chooseQuery() {
  if (src.mode !== 'query') {
    if (src.mode === 'table' || src.mode === 'view') src.query ||= `SELECT *\nFROM ${objectLabel(src)}`;
    src.mode = 'query';
    src.params = src.params.filter((p) => p.mode !== 'OUT');
  }
  src.query ??= '';
}
function detectParams() {
  const names = detectQueryParams(src.query ?? '');
  const prev = new Map(src.params.map((p) => [p.name.toLowerCase(), p]));
  src.params = names.map((n) => {
    const p = prev.get(n.toLowerCase());
    const rp = reportParamFor(n);
    return p ?? { name: n, type: (rp?.type ?? 'string') as ParamType, value: defaultValue(n), mode: 'IN' };
  });
  notify(names.length ? `Found ${names.length} parameter(s): ${names.join(', ')}` : 'No @name or :name parameters found in the query');
}
function linkReportParam(p: SqlParam) {
  let rp = reportParamFor(p.name);
  if (!rp) {
    const name = p.name.replace(/\W/g, '_').replace(/^(\d)/, '_$1');
    mutate((r) => {
      r.parameters.push({ id: uid('p'), name, label: p.name, type: p.type, defaultValue: '', values: '', visible: true });
    });
    rp = reportParamFor(name);
    notify(`Report parameter "${name}" created — the preview will ask for its value`);
  }
  p.value = `?${rp!.name}`;
}

onMounted(async () => {
  const loaded = await loadConnections();
  void refreshAuth();
  if (loaded && src.connectionId) {
    if (!current.value) error.value = `The connection "${src.connectionName ?? src.connectionId}" is not defined on this computer. Choose or create a connection.`;
    else await loadSchema();
  }
});
</script>

<template>
  <div class="col sql-editor" style="gap: 8px; min-height: 0">
    <!-- website without the ReportTool server (static hosting): explain, and offer what does work here -->
    <div v-if="noService" class="no-db">
      <div class="no-db-head"><DatabaseZap :size="20" /> Database connections don't work on this website</div>
      <p>This website runs only the designer, inside your browser. A browser cannot log in to SQL Server, Oracle, PostgreSQL or MySQL by itself: that needs ReportTool running on a computer that can reach the database.</p>
      <div class="no-db-ways">
        <div class="no-db-way">
          <b>Use your data on this website</b>
          <span>Paste the rows as CSV or JSON. From SQL Server Management Studio: run the query, right-click the results → <b>Copy with Headers</b>, then paste into CSV.</span>
          <div class="row" style="margin-top: 8px">
            <button class="btn small primary" @click="emit('switchKind', 'csv')"><Sheet :size="13" /> Use CSV data</button>
            <button class="btn small" @click="emit('switchKind', 'json')"><Braces :size="13" /> Use JSON data</button>
          </div>
        </div>
        <div class="no-db-way">
          <b>Design with the live database</b>
          <span>Run ReportTool on your computer (<code>npm run dev</code>) and create the connection there. When the design is finished, use <b>Copy Text</b> to take it to your system.</span>
        </div>
      </div>
    </div>
    <template v-else>
    <div class="row" style="flex-wrap: wrap">
      <b style="font-size: 12.5px">Connection</b>
      <select style="min-width: 260px" :value="src.connectionId" @change="pickConnection(($event.target as HTMLSelectElement).value)">
        <option value="">— choose a database connection —</option>
        <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }} · {{ providerLabel(c.provider) }}{{ c.hasPassword ? '' : ' (log in)' }}</option>
      </select>
      <button class="btn small" @click="connDialog = { conn: null }"><Plus :size="13" /> New connection…</button>
      <button class="btn small" :disabled="!current || current.fixed" :title="current?.fixed ? 'Set up on the server — cannot be changed here' : ''" @click="connDialog = { conn: current }">
        <Pencil :size="13" /> Edit
      </button>
      <button v-if="current && !current.hasPassword" class="btn small primary" @click="login"><KeyRound :size="13" /> Log in</button>
      <button class="icon-btn" :disabled="!current" title="Reload tables, views, procedures and functions" @click="loadSchema"><RefreshCw :size="14" /></button>
      <button class="icon-btn" :disabled="!current || current.fixed" :title="current?.fixed ? 'Set up on the server — cannot be deleted here' : 'Delete this connection'" @click="removeConnection">
        <Trash2 :size="14" />
      </button>
      <span class="grow" />
      <button v-if="signedIn" class="btn small" title="Sign out of this website's database access" @click="doSignOut"><LogOut :size="13" /> Sign out</button>
    </div>
    <div v-if="error" class="row err" style="gap: 8px">
      <span>{{ error }}</span>
      <button v-if="needSignIn" class="btn small primary" @click="signInAgain"><LogIn :size="13" /> Sign in</button>
    </div>

    <div class="split" style="height: 290px">
      <div class="col" style="width: 300px; min-width: 300px">
        <div class="row" style="gap: 4px"><Search :size="14" class="muted" /><input v-model="search" placeholder="Search tables, views, procedures…" style="flex: 1" /></div>
        <div class="list-box tree" style="flex: 1">
          <div class="tree-item" :class="{ sel: src.mode === 'query' }" @click="chooseQuery"><CodeXml :size="14" /> <b>Custom SQL query</b></div>
          <div v-if="!src.connectionId" class="empty-hint">Choose a connection, or click <b>New connection…</b> to log in to SQL Server, Oracle, PostgreSQL, MySQL or SQLite.</div>
          <div v-else-if="loadingSchema" class="empty-hint">Loading database objects…</div>
          <template v-for="k in KINDS" v-else :key="k.key">
            <template v-if="schema">
              <div class="tree-item" style="font-weight: 600" @click="open[k.key] = !open[k.key]">
                <component :is="open[k.key] ? ChevronDown : ChevronRight" :size="13" />
                <component :is="k.icon" :size="14" /> {{ k.label }}
                <span class="type">{{ filtered(k.key).length }}</span>
              </div>
              <template v-if="open[k.key]">
                <div
                  v-for="o in filtered(k.key).slice(0, 500)"
                  :key="fullName(o) + (o.specific ?? '')"
                  class="tree-item"
                  style="padding-left: 30px"
                  :class="{ sel: isSel(k.key, o) }"
                  :title="fullName(o) + (o.signature !== undefined ? '(' + o.signature + ')' : '') + (o.returnType ? ' → ' + o.returnType : '')"
                  @click="choose(k.key, o)"
                >
                  <span style="overflow: hidden; text-overflow: ellipsis">{{ fullName(o) }}</span>
                  <span v-if="o.returnsTable" class="type">table</span>
                </div>
                <div v-if="filtered(k.key).length > 500" class="hint" style="padding-left: 30px">…refine the search to see more</div>
              </template>
            </template>
          </template>
        </div>
      </div>

      <div class="col" style="flex: 1; min-width: 0">
        <div class="row">
          <Sheet :size="15" />
          <b>{{ src.mode === 'query' ? 'Custom SQL query' : src.name ? objectLabel(src) : 'Nothing selected' }}</b>
          <span v-if="src.mode !== 'query' && src.name" class="tag" style="font-size: 11px; color: var(--muted)">{{ src.mode }}{{ src.returnType ? ' → ' + src.returnType : '' }}</span>
          <span class="grow" />
          <label class="row hint">Max rows <input v-model.number="src.maxRows" type="number" min="1" style="width: 90px" placeholder="100000" /></label>
          <button class="btn small primary" :disabled="!src.connectionId || (src.mode !== 'query' && !src.name)" @click="emit('preview')"><Play :size="13" /> Preview data</button>
        </div>
        <template v-if="src.mode === 'query'">
          <textarea
            v-model="src.query"
            spellcheck="false"
            style="flex: 1; min-height: 110px; font-family: Consolas, monospace; font-size: 12.5px"
            placeholder="SELECT o.OrderID, c.Name, o.Amount&#10;FROM Orders o JOIN Customers c ON c.CustomerID = o.CustomerID&#10;WHERE o.OrderDate >= @FromDate AND c.Country = @Country"
          />
          <div class="row">
            <button class="btn small" @click="detectParams"><Variable :size="13" /> Detect parameters</button>
            <span class="hint">Write parameters as <code>@Name</code> or <code>:Name</code> — they are sent as bound values (safe from SQL injection).</span>
          </div>
        </template>
        <div v-if="src.params.length" class="list-box" style="max-height: 150px">
          <table class="data-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th style="width: 45%">Value (expression)</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in src.params" :key="p.name">
                <td>
                  {{ p.name }} <span v-if="p.mode && p.mode !== 'IN'" class="hint">{{ p.mode }}</span>
                  <span v-if="p.dbType" class="hint"> {{ p.dbType }}</span>
                </td>
                <td>
                  <select v-model="p.type" :disabled="p.mode === 'OUT'" style="height: 22px">
                    <option value="string">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Boolean</option>
                  </select>
                </td>
                <td style="max-width: none">
                  <span v-if="p.mode === 'OUT'" class="hint">{{ p.dbType === 'REF CURSOR' ? 'result rows' : 'output' }}</span>
                  <ExprInput v-else v-model="p.value" :title="'Value of ' + p.name" placeholder="e.g. ?CustomerId, 'USA', 10, Today()" />
                </td>
                <td>
                  <button v-if="p.mode !== 'OUT'" class="btn small" :title="'Bind to a report parameter the user fills in before the report runs'" @click="linkReportParam(p)">
                    <Variable :size="12" /> {{ reportParamFor(p.name) ? 'Use ?' + reportParamFor(p.name)!.name : 'Report parameter' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="src.mode === 'procedure' || src.mode === 'function'" class="hint">This routine has no input parameters.</div>
      </div>
    </div>
    </template>
    <ConnectionDialog v-if="connDialog" :connection="connDialog.conn" @close="connDialog = null" @saved="onSaved" />
  </div>
</template>
