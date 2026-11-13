// Public mode (REPORTTOOL_PUBLIC=1): anyone may use the website's database features, so the server must not become
// a door into places visitors should not reach:
//  - only databases on the public internet: no localhost / private networks / cloud metadata addresses
//  - no SQLite files (they would be files on this server) and no Oracle connect strings (hosts hidden inside)
//  - a limit on connection attempts per visitor address (no password guessing against other people's databases)
import dns from 'node:dns/promises';
import net from 'node:net';
import { ApiError } from './common.mjs';
import { PUBLIC } from './auth.mjs';

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast / reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return privateV4(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

/** Throws when a connection would leave the public internet (public mode only). */
export async function assertPublicTarget(c) {
  if (!PUBLIC) return;
  if (c.provider === 'sqlite') throw new ApiError('SQLite database files are not available on this website. Use SQL Server, Oracle, PostgreSQL or MySQL.');
  if (String(c.connectString ?? '').trim()) throw new ApiError('Enter the host and port instead of a connect string on this website.');
  const host = String(c.host ?? '').trim();
  if (!host) throw new ApiError('Enter the server name.');
  let addrs;
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) addrs = [host];
  else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new ApiError(`Cannot reach the database server: the name "${host}" was not found.`);
    }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) {
    throw new ApiError('This website can only connect to database servers on the public internet (not localhost or private network addresses).');
  }
}

// at most 30 connection attempts (test / log in) per visitor address in 10 minutes
const attempts = new Map();
const MAX_ATTEMPTS = 30;
const WINDOW_MS = 10 * 60 * 1000;
export function countAttempt(req) {
  if (!PUBLIC) return;
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const now = Date.now();
  const a = attempts.get(ip);
  const list = (a ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_ATTEMPTS) throw new ApiError('Too many connection attempts. Wait a few minutes and try again.', 429);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 10000) attempts.clear();
}
