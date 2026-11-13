// Database connections (server, port, database, user name — never shown to the browser with a password).
// By default they are kept IN MEMORY ONLY: nothing is written to disk and they are gone when the server stops.
// Set REPORTTOOL_SAVE_CONNECTIONS=1 to keep them in <project>/.reporttool/connections.json (or REPORTTOOL_DATA_DIR);
// a password is written there only when, in addition, the user ticks "Save password".
// In public mode (REPORTTOOL_PUBLIC=1) every connection has an `owner` (the visitor's anonymous id): a browser only
// ever sees and uses its own connections.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PUBLIC } from './auth.mjs';

const DIR = process.env.REPORTTOOL_DATA_DIR || path.resolve(process.cwd(), '.reporttool');
const FILE = path.join(DIR, 'connections.json');
/** keep connections on disk (opt-in) */
export const PERSIST = /^(1|true|yes)$/i.test(process.env.REPORTTOOL_SAVE_CONNECTIONS ?? '');
const PROVIDERS = new Set(['mssql', 'postgres', 'mysql', 'oracle', 'sqlite']);
const FIELDS = ['id', 'name', 'provider', 'host', 'port', 'instance', 'database', 'user', 'auth', 'domain', 'encrypt', 'trustServerCertificate', 'ssl', 'file', 'connectString', 'schema', 'savePassword'];

/** @type {Map<string, any>} */
let conns = new Map();
/** in-memory passwords for this server session */
const memory = new Map();

function load() {
  if (!PERSIST) return;
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    conns = new Map(list.map((c) => [c.id, c]));
  } catch {
    conns = new Map();
  }
}

/**
 * Connections set up by the server owner (e.g. a secret environment variable on Render), with their passwords:
 *   REPORTTOOL_CONNECTIONS='[{"name":"Sales","provider":"mssql","host":"db.example.com","port":1433,
 *                             "database":"SalesDB","user":"report_reader","password":"..."}]'
 * They exist from start-up (also after a restart), keep a fixed id, and cannot be changed or deleted in the designer.
 */
function loadFixed() {
  const raw = process.env.REPORTTOOL_CONNECTIONS;
  if (!raw?.trim()) return;
  if (PUBLIC) {
    // they would be usable by every visitor of a public website
    console.warn('REPORTTOOL_CONNECTIONS is ignored in public mode (REPORTTOOL_PUBLIC=1): visitors add their own connections.');
    return;
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    console.error('REPORTTOOL_CONNECTIONS is not valid JSON:', e.message);
    return;
  }
  for (const input of [].concat(list)) {
    try {
      validate(input);
      const name = String(input.name).trim();
      const id = 'env-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const c = { ...pick(input), id, name, fixed: true };
      delete c.savePassword;
      conns.set(id, c);
      if (typeof input.password === 'string') memory.set(id, input.password);
      console.log(`Database connection from REPORTTOOL_CONNECTIONS: ${name}`);
    } catch (e) {
      console.error('REPORTTOOL_CONNECTIONS entry skipped:', e.message);
    }
  }
}

/** same details (and, in public mode, same visitor) -> same id: a report finds its connection again after a restart */
function stableId(c, owner) {
  const key = ['provider', 'host', 'port', 'instance', 'database', 'user', 'auth', 'domain', 'file', 'connectString'].map((k) => String(c[k] ?? '').trim().toLowerCase()).join('|');
  return 'c-' + crypto.createHash('sha256').update(key + '|' + (owner ?? '')).digest('hex').slice(0, 16);
}
const ownerOf = (c) => c.owner ?? null;
const mine = (c, owner) => ownerOf(c) === (owner ?? null);
const MAX_PER_VISITOR = 20;
const MAX_TOTAL = 5000;
function persist() {
  if (!PERSIST) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify([...conns.values()].filter((c) => !c.fixed), null, 2), { mode: 0o600 });
}
const pick =(c) => Object.fromEntries(FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
const hasPassword = (c) => c.provider === 'sqlite' || memory.has(c.id) || typeof c.password === 'string';
export function publicConn(c) {
  const { password, owner, ...rest } = c;
  return { ...rest, hasPassword: hasPassword(c) };
}

/** The connections of `owner` (public mode: one visitor; otherwise everybody's shared list). */
export function listConnections(owner) {
  return [...conns.values()].filter((c) => mine(c, owner)).map(publicConn).sort((a, b) => a.name.localeCompare(b.name));
}

/** Full connection including the password (memory first, then saved) — only when it belongs to `owner`. */
export function getConnection(id, owner) {
  const c = conns.get(id) ?? [...conns.values()].find((x) => x.name === id && mine(x, owner));
  if (!c || !mine(c, owner)) return null;
  const pw = memory.has(c.id) ? memory.get(c.id) : c.password;
  return { ...c, password: pw };
}

export function validate(c) {
  if (!c || !PROVIDERS.has(c.provider)) throw new Error('Choose a database type.');
  if (!String(c.name ?? '').trim()) throw new Error('Enter a connection name.');
  if (c.provider === 'sqlite' && !String(c.file ?? '').trim()) throw new Error('Enter the SQLite file path.');
}

const FIXED_MSG = 'This connection is set up on the server (REPORTTOOL_CONNECTIONS) and cannot be changed or deleted here.';

export function saveConnection(input, owner) {
  validate(input);
  let id;
  if (input.id && conns.has(input.id) && mine(conns.get(input.id), owner)) {
    if (conns.get(input.id).fixed) throw new Error(FIXED_MSG);
    id = input.id;
  } else {
    id = stableId(input, owner);
    const same = conns.get(id);
    if (same) throw new Error(`This connection already exists as "${same.name}".`);
    if (owner && [...conns.values()].filter((x) => mine(x, owner)).length >= MAX_PER_VISITOR) throw new Error(`You can keep up to ${MAX_PER_VISITOR} connections. Delete one you no longer need.`);
    if (conns.size >= MAX_TOTAL) throw new Error('This website has too many connections right now. Try again later.');
  }
  const dup = [...conns.values()].find((x) => mine(x, owner) && x.name.toLowerCase() === String(input.name).trim().toLowerCase() && x.id !== id);
  if (dup) throw new Error(`A connection named "${input.name}" already exists.`);
  const prev = conns.get(id);
  const c = { ...pick(input), id, name: String(input.name).trim() };
  if (owner) c.owner = owner;
  if (typeof input.password === 'string') memory.set(id, input.password);
  const pw = memory.has(id) ? memory.get(id) : prev?.password;
  if (PERSIST && c.savePassword && typeof pw === 'string') c.password = pw;
  if (!PERSIST) delete c.savePassword;
  conns.set(id, c);
  persist();
  return publicConn(c);
}

export function setPassword(id, password) {
  memory.set(id, password);
}

export function deleteConnection(id, owner) {
  const c = conns.get(id);
  if (!c || !mine(c, owner)) return false;
  if (c.fixed) throw new Error(FIXED_MSG);
  memory.delete(id);
  const ok = conns.delete(id);
  persist();
  return ok;
}

export function needsPassword(c) {
  return !hasPassword(c);
}

load();
loadFixed();
