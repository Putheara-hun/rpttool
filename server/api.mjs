// HTTP API for database access. Mounted as connect-style middleware (Vite dev server) or by server/index.mjs.
import { ApiError } from './common.mjs';
import { AUTH_ENABLED, login, logout, signedIn } from './auth.mjs';
import { deleteConnection, getConnection, listConnections, needsPassword, PERSIST, publicConn, saveConnection, setPassword, validate } from './store.mjs';

const DRIVERS = {
  mssql: () => import('./drivers/mssql.mjs'),
  postgres: () => import('./drivers/postgres.mjs'),
  mysql: () => import('./drivers/mysql.mjs'),
  oracle: () => import('./drivers/oracle.mjs'),
  sqlite: () => import('./drivers/sqlite.mjs'),
};
async function driver(provider) {
  const f = DRIVERS[provider];
  if (!f) throw new ApiError('Unsupported database type: ' + provider);
  return (await f()).default;
}

const MAX_ROWS = 1_000_000;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
/** extra host names (without port) the API answers on, e.g. REPORTTOOL_ALLOWED_HOSTS=reports.example.com */
const EXTRA_HOSTS = (process.env.REPORTTOOL_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// With a team password (REPORTTOOL_PASSWORD) the API may be used from any address: sign-in protects it.
const hostAllowed = (host) =>
  AUTH_ENABLED || !!process.env.REPORTTOOL_ALLOW_REMOTE || LOCAL_HOSTS.test(host) || EXTRA_HOSTS.includes(host.toLowerCase().replace(/:\d+$/, ''));

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new ApiError('Request too large', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Resolve a connection by id and make sure we know its password. */
function connFor(id) {
  const c = getConnection(id);
  if (!c) throw new ApiError(`Database connection "${id}" was not found. Choose or create a connection in the data source settings.`, 404, { missingConnection: true });
  if (needsPassword(c)) throw new ApiError(`Log in to "${c.name}" to continue.`, 401, { needLogin: true, connectionId: c.id, name: c.name, user: c.user });
  return c;
}

function friendly(e) {
  // Node wraps parallel IPv4/IPv6 connection failures in an AggregateError with an empty message
  if (e && Array.isArray(e.errors) && e.errors.length && !e.message) e = e.errors[e.errors.length - 1];
  let msg = e?.message || e?.code || String(e);
  if (e?.code === 'ECONNREFUSED' && e.address) msg = `connection refused at ${e.address}:${e.port} — is the server running and is the port correct?`;
  if (/client password must be a string|password authentication failed|ORA-01017|Login failed for user|Access denied for user/i.test(msg) && !/^Login/.test(msg)) msg = 'Login failed: ' + msg;
  if (/ECONNREFUSED|ESOCKET|ETIMEOUT|ETIMEDOUT|getaddrinfo|ENOTFOUND|connect timeout|NJS-503|NJS-511/i.test(msg)) return `Cannot reach the database server: ${msg}`;
  return msg;
}

async function route(method, url, body) {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/api/connections') return listConnections();
  if (method === 'POST' && path === '/api/connections') return saveConnection(body);
  let m = /^\/api\/connections\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && m) return { ok: deleteConnection(decodeURIComponent(m[1])) };

  if (method === 'POST' && path === '/api/connections/test') {
    // test an unsaved connection definition (password may be omitted to reuse the stored one)
    const input = body.connection ?? {};
    validate(input);
    const stored = input.id ? getConnection(input.id) : null;
    const c = { ...input, id: input.id || 'test:' + Date.now(), password: typeof input.password === 'string' ? input.password : stored?.password };
    const d = await driver(c.provider);
    try {
      const version = await d.test(c);
      return { ok: true, version };
    } finally {
      if (!input.id) d.close(c.id);
    }
  }
  m = /^\/api\/connections\/([^/]+)\/login$/.exec(path);
  if (method === 'POST' && m) {
    const c = getConnection(decodeURIComponent(m[1]));
    if (!c) throw new ApiError('Connection not found', 404);
    const d = await driver(c.provider);
    const version = await d.test({ ...c, password: body.password ?? '' });
    setPassword(c.id, body.password ?? '');
    return { ok: true, version, connection: publicConn(getConnection(c.id)) };
  }
  if (method === 'POST' && path === '/api/db/schema') {
    const c = connFor(body.connectionId);
    return (await driver(c.provider)).schema(c);
  }
  if (method === 'POST' && path === '/api/db/params') {
    const c = connFor(body.connectionId);
    return (await driver(c.provider)).params(c, body.object ?? {});
  }
  if (method === 'POST' && path === '/api/db/execute') {
    const c = connFor(body.connectionId);
    const src = body.source ?? {};
    if (src.mode === 'query' && !String(src.query ?? '').trim()) throw new ApiError('Enter a SQL query.');
    if (src.mode !== 'query' && !src.name) throw new ApiError('Choose a table, view, procedure or function.');
    const maxRows = Math.max(1, Math.min(MAX_ROWS, Number(body.maxRows) || 100000));
    const values = Object.fromEntries((body.params ?? []).map((p) => [p.name, p]));
    const t0 = Date.now();
    const r = await (await driver(c.provider)).execute(c, src, values, maxRows);
    return { ...r, ms: Date.now() - t0 };
  }
  throw new ApiError('Not found: ' + method + ' ' + path, 404);
}

/** Connect/Express-style middleware. */
export function createApiHandler() {
  return async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' });
    // design-only deployment (the host systems send the data): no database access at all
    if (process.env.REPORTTOOL_DISABLE_DB) return send(res, 404, { error: 'Database access is turned off on this server.', noService: true });
    // Only answer requests made by the ReportTool UI itself:
    //  - Host must be localhost or a name listed in REPORTTOOL_ALLOWED_HOSTS (blocks DNS-rebinding)
    //  - custom header required (a cross-site page cannot send it without a CORS preflight, which we never allow)
    if (!hostAllowed(req.headers.host ?? '')) {
      return send(res, 403, {
        error: 'Database access from the internet is turned off on this server. The server owner can turn it on by setting a team password (REPORTTOOL_PASSWORD).',
        noService: true,
      });
    }
    if (req.method === 'OPTIONS' || req.headers['x-reporttool'] !== '1') return send(res, 403, { error: 'Forbidden' });
    try {
      const path = url.split('?')[0];
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'GET' && path === '/api/health') {
        return send(res, 200, { ok: true, providers: Object.keys(DRIVERS), savesConnections: PERSIST, auth: AUTH_ENABLED, signedIn: signedIn(req) });
      }
      // team password (REPORTTOOL_PASSWORD): sign in / out, everything else needs a signed-in browser
      if (req.method === 'POST' && path === '/api/auth/login') {
        const r = login(req, res, body.password);
        return send(res, r.status, r.body);
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        const r = logout(req, res);
        return send(res, r.status, r.body);
      }
      if (!signedIn(req)) return send(res, 401, { error: 'Sign in with the team password to use database connections.', authRequired: true });
      send(res, 200, await route(req.method, url, body));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 400;
      send(res, status, { error: friendly(e), ...(e instanceof ApiError ? e.extra : {}) });
    }
  };
}
