// Team password for the database API, for a ReportTool that is reachable from the internet (e.g. on Render).
//   REPORTTOOL_PASSWORD=...  -> /api/* (except health / sign-in) needs a signed-in browser.
// Without it the API stays local-only (see hostAllowed in api.mjs).
// Session = HttpOnly cookie "<expiry>.<HMAC>"; the HMAC key comes from the password, so sessions survive restarts
// (Render's free plan sleeps) and all end when the password is changed.
import crypto from 'node:crypto';

const PASSWORD = process.env.REPORTTOOL_PASSWORD ?? '';
export const AUTH_ENABLED = PASSWORD.length > 0;
/**
 * Public mode (REPORTTOOL_PUBLIC=1, no team password): anyone may use databases on this website, and each browser
 * gets its own private list of connections (anonymous visitor cookie) that nobody else can see or use.
 * A team password wins when both are set (team mode: one shared list for the team).
 */
export const PUBLIC = !AUTH_ENABLED && /^(1|true|yes)$/i.test(process.env.REPORTTOOL_PUBLIC ?? '');
const KEY = crypto.createHash('sha256').update('reporttool-session\n' + PASSWORD).digest();
const COOKIE = 'rt_session';
const MAX_AGE_S = 7 * 24 * 3600;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sign = (s) => crypto.createHmac('sha256', KEY).update(s).digest('base64url');

function cookieValue(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * Public mode: the anonymous id of this browser (owner of its connections); a new one is handed out on the first
 * request. Undefined in local / team mode (one shared list).
 */
const VISITOR = 'rt_visitor';
export function visitorOf(req, res) {
  if (!PUBLIC) return undefined;
  let v = cookieValue(req, VISITOR);
  if (!/^[A-Za-z0-9_-]{24}$/.test(v)) {
    v = crypto.randomBytes(18).toString('base64url');
    res.setHeader('Set-Cookie', `${VISITOR}=${v}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}${https(req) ? '; Secure' : ''}`);
  }
  return v;
}

/** is this browser signed in? (always true when no team password is configured) */
export function signedIn(req) {
  if (!AUTH_ENABLED) return true;
  const [exp, mac] = cookieValue(req).split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const https = (req) => req.socket?.encrypted || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
function setCookie(req, res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https(req) ? '; Secure' : ''}`);
}

// brute-force guard: 10 wrong passwords per client address -> 15 minutes locked
const failures = new Map();
const LIMIT = 10;
const LOCK_MS = 15 * 60 * 1000;
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '?';

/** POST /api/auth/login {password} -> { status, body } */
export function login(req, res, password) {
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.count >= LIMIT && Date.now() - f.last < LOCK_MS) {
    return { status: 429, body: { error: 'Too many wrong passwords. Try again in 15 minutes.' } };
  }
  const ok = AUTH_ENABLED && typeof password === 'string' && crypto.timingSafeEqual(sha(password), sha(PASSWORD));
  if (!ok) {
    const n = f && Date.now() - f.last < LOCK_MS ? f.count + 1 : 1;
    failures.set(ip, { count: n, last: Date.now() });
    if (failures.size > 10000) failures.clear();
    return { status: 401, body: { error: 'Wrong password.' } };
  }
  failures.delete(ip);
  const exp = String(Date.now() + MAX_AGE_S * 1000);
  setCookie(req, res, `${exp}.${sign(exp)}`, MAX_AGE_S);
  return { status: 200, body: { ok: true } };
}

export function logout(req, res) {
  setCookie(req, res, '', 0);
  return { status: 200, body: { ok: true } };
}
