<script setup lang="ts">
import { computed, ref } from 'vue';
import { CircleCheck, Database, PlugZap, CircleX } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { DbError, PROVIDERS, saveConnection, serverHealth, testConnection, type DbConnection, type Provider } from '../data/dbApi';

const props = defineProps<{ connection?: DbConnection | null }>();
const emit = defineEmits<{ close: []; saved: [c: DbConnection] }>();

const editing = !!props.connection?.id;
const c = ref<DbConnection>({
  name: '',
  provider: 'mssql',
  host: 'localhost',
  port: 1433,
  database: '',
  user: '',
  auth: 'sql',
  encrypt: false,
  trustServerCertificate: true,
  savePassword: false,
  ...(props.connection ?? {}),
  password: undefined,
});
const password = ref('');
const testing = ref(false);
const saving = ref(false);
const result = ref<{ ok: boolean; text: string } | null>(null);
const info = computed(() => PROVIDERS.find((p) => p.id === c.value.provider)!);
/** does the server keep connections on disk (REPORTTOOL_SAVE_CONNECTIONS=1)? */
const savesConnections = ref(false);
/** no ReportTool server on this website: say so before anyone types a server password */
const noService = ref('');
/** public website (REPORTTOOL_PUBLIC=1): connections are private to this browser; no SQLite files */
const publicMode = ref(false);
const providers = computed(() => PROVIDERS.filter((p) => !(publicMode.value && p.id === 'sqlite')));
void serverHealth()
  .then((h) => {
    savesConnections.value = !!h.savesConnections;
    publicMode.value = !!h.public;
  })
  .catch((e) => {
    if (e instanceof DbError && e.noService) noService.value = e.message;
  });
const isFile = computed(() => c.value.provider === 'sqlite');

function setProvider(p: Provider) {
  const prevDefault = PROVIDERS.find((x) => x.id === c.value.provider)?.port;
  c.value.provider = p;
  if (!c.value.port || Number(c.value.port) === prevDefault) c.value.port = PROVIDERS.find((x) => x.id === p)?.port;
  if (p === 'oracle' && !c.value.database) c.value.database = 'XEPDB1';
  if (p === 'postgres' && !c.value.user) c.value.user = 'postgres';
  result.value = null;
}
/**
 * SQL Server: accept the SSMS notations "server,port" and "server\instance" in the Server box,
 * and fix values pasted into the Instance box that are really a server name / port.
 */
function normalizeMssql() {
  const v = c.value;
  if (v.provider !== 'mssql') return;
  let host = (v.host ?? '').trim();
  let inst = (v.instance ?? '').trim();
  const hostPort = /^(.*?)\s*,\s*(\d+)$/.exec(host);
  if (hostPort) {
    host = hostPort[1];
    v.port = Number(hostPort[2]);
  }
  const hb = host.indexOf('\\');
  if (hb > 0) {
    inst = inst || host.slice(hb + 1);
    host = host.slice(0, hb);
  }
  const instPort = /^(.*?)\s*,\s*(\d+)$/.exec(inst);
  if (instPort) {
    // "server, 1433" typed into Instance -> it is a server + port, not an instance
    if (!host) host = instPort[1];
    v.port = Number(instPort[2]);
    inst = '';
  }
  const ib = inst.indexOf('\\');
  if (ib >= 0) {
    if (!host) host = inst.slice(0, ib);
    inst = inst.slice(ib + 1);
  }
  if (inst && inst.toLowerCase() === host.toLowerCase()) inst = '';
  v.host = host;
  v.instance = inst;
}
const instanceWarning = computed(() =>
  /[.,:\s]/.test(c.value.instance ?? '') ? 'An instance name is only a short name such as SQLEXPRESS — not a server name or port. Leave it empty when you connect with a port.' : '',
);

function payload(): DbConnection {
  normalizeMssql();
  const out: DbConnection = { ...c.value };
  // a blank password means "not entered": the app asks for it (login prompt) when the connection is used
  if (password.value !== '') out.password = password.value;
  else delete out.password;
  if (!out.name.trim()) out.name = defaultName();
  return out;
}
function defaultName() {
  const v = c.value;
  if (v.provider === 'sqlite') return (v.file ?? 'SQLite').split(/[\\/]/).pop() || 'SQLite';
  return `${v.database || v.host || 'db'} (${info.value.label.split(' ')[0]})`;
}
async function test() {
  testing.value = true;
  result.value = null;
  try {
    const r = await testConnection(payload());
    result.value = { ok: true, text: 'Connected: ' + r.version };
  } catch (e) {
    result.value = { ok: false, text: (e as Error).message };
  } finally {
    testing.value = false;
  }
}
async function save() {
  saving.value = true;
  try {
    const saved = await saveConnection(payload());
    emit('saved', saved);
  } catch (e) {
    result.value = { ok: false, text: (e as Error).message };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal :title="editing ? 'Edit Database Connection' : 'New Database Connection'" :width="640" @close="emit('close')">
    <template #icon><Database :size="16" /></template>
    <div v-if="noService" class="row err" style="align-items: flex-start; margin-bottom: 12px">
      <CircleX :size="16" style="flex: none" />
      <span>{{ noService }}</span>
    </div>
    <div class="form-grid" style="grid-template-columns: 150px 1fr">
      <label>Database type</label>
      <select :value="c.provider" @change="setProvider(($event.target as HTMLSelectElement).value as Provider)">
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
      <label>Connection name</label>
      <input v-model="c.name" :placeholder="defaultName()" />

      <template v-if="isFile">
        <label>Database file</label>
        <input v-model="c.file" placeholder="C:\data\shop.db" />
      </template>
      <template v-else>
        <label>{{ c.provider === 'mssql' ? 'Server' : 'Host' }}</label>
        <div class="row">
          <input v-model="c.host" style="flex: 1" placeholder="localhost or server name / IP" @blur="normalizeMssql" />
          <span>Port</span>
          <input
            v-model.number="c.port"
            type="number"
            style="width: 80px"
            :disabled="c.provider === 'mssql' && !!c.instance"
            :title="c.provider === 'mssql' && c.instance ? 'Not used: an instance name is set (SQL Browser finds the port)' : ''"
          />
        </div>
        <template v-if="c.provider === 'mssql'">
          <label>Instance name</label>
          <div class="col" style="gap: 3px">
            <input v-model="c.instance" placeholder="usually empty — only for a named instance such as SQLEXPRESS" @blur="normalizeMssql" />
            <span v-if="instanceWarning" class="err">{{ instanceWarning }}</span>
            <span v-else-if="c.instance" class="hint">Connects through the SQL Server Browser service (UDP 1434); the port is ignored.</span>
          </div>
        </template>
        <label>{{ info.dbLabel }}</label>
        <input v-model="c.database" :placeholder="c.provider === 'oracle' ? 'e.g. ORCLPDB1, XEPDB1' : 'database name'" />
        <template v-if="c.provider === 'oracle'">
          <label>Connect string</label>
          <input v-model="c.connectString" placeholder="optional — overrides host/port/service, e.g. host:1521/service or a TNS descriptor" />
          <label>Schema to browse</label>
          <input v-model="c.schema" placeholder="optional — defaults to the login user" />
        </template>
        <template v-if="c.provider === 'mssql'">
          <label>Authentication</label>
          <select v-model="c.auth">
            <option value="sql">SQL Server authentication</option>
            <option value="ntlm">Windows authentication (domain user + password)</option>
          </select>
          <template v-if="c.auth === 'ntlm'">
            <label>Domain</label>
            <input v-model="c.domain" placeholder="DOMAIN or computer name" />
          </template>
        </template>
        <label>User name</label>
        <input v-model="c.user" autocomplete="username" />
        <label>Password</label>
        <input v-model="password" type="password" autocomplete="current-password" :placeholder="editing ? (c.hasPassword ? '(unchanged)' : 'enter password') : ''" />
        <label>Options</label>
        <div class="col" style="gap: 4px">
          <template v-if="c.provider === 'mssql'">
            <label class="row"><input v-model="c.encrypt" type="checkbox" /> Encrypt connection</label>
            <label class="row"><input v-model="c.trustServerCertificate" type="checkbox" /> Trust server certificate</label>
          </template>
          <label v-if="c.provider === 'postgres' || c.provider === 'mysql'" class="row"><input v-model="c.ssl" type="checkbox" /> Use SSL</label>
          <template v-if="savesConnections">
            <label class="row"><input v-model="c.savePassword" type="checkbox" /> Save password on this computer</label>
            <span v-if="c.savePassword" class="hint">The password is stored in plain text in <code>.reporttool/connections.json</code> next to the app. Leave this off to be asked once per session.</span>
            <span v-else class="hint">The password is kept in memory only; you will be asked to log in again after the app restarts.</span>
          </template>
          <span v-else-if="publicMode" class="hint">
            Only this browser can see and use this connection — other visitors of the website cannot. Nothing is saved to disk: it is kept in the website's memory until the website restarts.
          </span>
          <span v-else class="hint">Nothing is saved to disk: the connection and its password are kept in memory only, until ReportTool is restarted.</span>
        </div>
      </template>
    </div>
    <div v-if="result" class="row" style="margin-top: 12px; align-items: flex-start" :class="result.ok ? 'ok' : 'err'">
      <component :is="result.ok ? CircleCheck : CircleX" :size="16" style="flex: none" />
      <span style="word-break: break-word">{{ result.text }}</span>
    </div>
    <template #footer>
      <button class="btn" :disabled="testing || !!noService" @click="test"><PlugZap :size="14" /> {{ testing ? 'Testing…' : 'Test connection' }}</button>
      <span class="grow" />
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn primary" :disabled="saving || !!noService" @click="save">{{ saving ? 'Saving…' : 'Save' }}</button>
    </template>
  </Modal>
</template>
