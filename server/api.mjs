// HTTP API for database access. Mounted as connect-style middleware (Vite dev server) or by server/index.mjs.
import { ApiError } from './common.mjs';
import { AUTH_ENABLED, login, logout, PUBLIC, signedIn, visitorOf } from './auth.mjs';
import { assertPublicTarget, countAttempt, isPrivateAddress } from './netguard.mjs';
import dns from 'node:dns/promises';
import net from 'node:net';
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
// In public mode (REPORTTOOL_PUBLIC=1) too: every browser only has its own connections.
const hostAllowed = (host) =>
  AUTH_ENABLED || PUBLIC || !!process.env.REPORTTOOL_ALLOW_REMOTE || LOCAL_HOSTS.test(host) || EXTRA_HOSTS.includes(host.toLowerCase().replace(/:\d+$/, ''));

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

/** Resolve a connection of this browser (public mode) by id and make sure we know its password. */
async function connFor(id, owner, name) {
  // by id; else by the connection name saved in the report (the same connection created again after a restart)
  const c = getConnection(id, owner) ?? (name ? getConnection(String(name), owner) : null);
  if (!c) {
    throw new ApiError(
      `The database connection "${name || id}" is not set up here. Add it in the designer on this website (Data Sources ▸ New connection…), or let the application send this report's rows.`,
      404,
      { missingConnection: true },
    );
  }
  if (needsPassword(c)) throw new ApiError(`Log in to "${c.name}" to continue.`, 401, { needLogin: true, connectionId: c.id, name: c.name, user: c.user });
  await assertPublicTarget(c);
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

/** `owner`: the visitor in public mode (each browser has its own connections), otherwise undefined (shared list). */
async function route(method, url, body, owner, req) {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/api/connections') return listConnections(owner);
  if (method === 'POST' && path === '/api/connections') {
    validate(body);
    await assertPublicTarget(body);
    return saveConnection(body, owner);
  }
  let m = /^\/api\/connections\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && m) return { ok: deleteConnection(decodeURIComponent(m[1]), owner) };

  if (method === 'POST' && path === '/api/connections/test') {
    // test an unsaved connection definition (password may be omitted to reuse the stored one)
    const input = body.connection ?? {};
    validate(input);
    countAttempt(req);
    await assertPublicTarget(input);
    const stored = input.id ? getConnection(input.id, owner) : null;
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
    const c = getConnection(decodeURIComponent(m[1]), owner);
    if (!c) throw new ApiError('Connection not found', 404);
    countAttempt(req);
    await assertPublicTarget(c);
    const d = await driver(c.provider);
    const version = await d.test({ ...c, password: body.password ?? '' });
    setPassword(c.id, body.password ?? '');
    return { ok: true, version, connection: publicConn(getConnection(c.id, owner)) };
  }
  if (method === 'POST' && path === '/api/db/schema') {
    const c = await connFor(body.connectionId, owner);
    return (await driver(c.provider)).schema(c);
  }
  if (method === 'POST' && path === '/api/db/params') {
    const c = await connFor(body.connectionId, owner);
    return (await driver(c.provider)).params(c, body.object ?? {});
  }
  if (method === 'POST' && path === '/api/db/execute') {
    const c = await connFor(body.connectionId, owner, body.connectionName);
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

// ------------------------------------------------------------------ pictures from other websites
// Many websites let a browser show their pictures but not read them (no CORS), so PDF / Excel / Word / PNG exports
// could not include them. The designer asks this server instead: GET /api/image?url=https://… returns the picture.
// Only for ReportTool's own pages (x-reporttool header), only pictures, at most 8 MB; when the server is on the
// internet (not localhost) it never fetches from localhost / private networks.
const IMAGE_MAX = 8 * 1024 * 1024;
async function publicHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [h] : (await dns.lookup(h, { all: true }).catch(() => [])).map((a) => a.address);
  return addrs.length > 0 && !addrs.some(isPrivateAddress);
}
async function imageProxy(req, res) {
  if (req.method !== 'GET' || req.headers['x-reporttool'] !== '1' || !hostAllowed(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden' });
  if (!signedIn(req)) return send(res, 401, { error: 'Sign in first.', authRequired: true });
  const local = LOCAL_HOSTS.test(req.headers.host ?? '');
  let target;
  try {
    target = new URL(new URL(req.url, 'http://x').searchParams.get('url') ?? '');
  } catch {
    return send(res, 400, { error: 'Not a web address.' });
  }
  try {
    // follow at most 3 redirects, checking every address on the way
    let r;
    for (let hop = 0; ; hop++) {
      if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: 'Only http(s) web addresses.' });
      if (!local && !(await publicHost(target.hostname))) return send(res, 400, { error: 'Only pictures from public websites.' });
      r = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (ReportTool picture loader)' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location') && hop < 3) {
        target = new URL(r.headers.get('location'), target);
        continue;
      }
      break;
    }
    const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!r.ok) return send(res, 502, { error: `The website answered ${r.status}.` });
    if (!type.startsWith('image/')) return send(res, 415, { error: 'That address is not a picture.' });
    if (Number(r.headers.get('content-length') ?? 0) > IMAGE_MAX) return send(res, 413, { error: 'The picture is larger than 8 MB.' });
    const chunks = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > IMAGE_MAX) return send(res, 413, { error: 'The picture is larger than 8 MB.' });
      chunks.push(c);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // never runs as a page of this site (an SVG picture can hold scripts)
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    return res.end(Buffer.concat(chunks));
  } catch (e) {
    return send(res, 502, { error: 'The picture could not be loaded: ' + (e?.name === 'TimeoutError' ? 'the website did not answer in time.' : e?.message ?? e) });
  }
}

/** Connect/Express-style middleware. */
export function createApiHandler() {
  return async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' });
    // pictures from other websites: also on design-only servers (no database access)
    if (url.split('?')[0] === '/api/image') return imageProxy(req, res);
    // design-only deployment (the host systems send the data): no database access at all
    if (process.env.REPORTTOOL_DISABLE_DB) return send(res, 404, { error: 'Database access is turned off on this server.', noService: true });
    // Only answer requests made by the ReportTool UI itself:
    //  - Host must be localhost or a name listed in REPORTTOOL_ALLOWED_HOSTS (blocks DNS-rebinding)
    //  - custom header required (a cross-site page cannot send it without a CORS preflight, which we never allow)
    if (!hostAllowed(req.headers.host ?? '')) {
      return send(res, 403, {
        error:
          'Database access from the internet is turned off on this server. The server owner can turn it on with REPORTTOOL_PUBLIC=1 (anyone, private connections per browser) or a team password (REPORTTOOL_PASSWORD).',
        noService: true,
      });
    }
    if (req.method === 'OPTIONS' || req.headers['x-reporttool'] !== '1') return send(res, 403, { error: 'Forbidden' });
    let body = {};
    try {
      const path = url.split('?')[0];
      body = req.method === 'POST' ? await readJson(req) : {};
      // public mode: this browser's anonymous id (handed out on its first request)
      const owner = visitorOf(req, res);
      if (req.method === 'GET' && path === '/api/health') {
        const providers = Object.keys(DRIVERS).filter((p) => !(PUBLIC && p === 'sqlite'));
        return send(res, 200, { ok: true, providers, savesConnections: PERSIST, auth: AUTH_ENABLED, signedIn: signedIn(req), public: PUBLIC });
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
      send(res, 200, await route(req.method, url, body, owner, req));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 400;
      const error = friendly(e);
      // a saved connection whose login the database refuses: the designer asks for server / user / password again
      const authFailed = !!body?.connectionId && LOGIN_FAILED.test(error);
      send(res, status, { error, ...(e instanceof ApiError ? e.extra : {}), ...(authFailed ? { authFailed: true, connectionId: body.connectionId } : {}) });
    }
  };
}
const LOGIN_FAILED = /^Login failed|password authentication failed|ORA-01017|Access denied for user/i;
