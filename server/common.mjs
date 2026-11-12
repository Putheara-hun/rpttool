// Shared helpers for the database drivers.

export class ApiError extends Error {
  /** @param {string} message @param {number} [status] @param {object} [extra] */
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Identifier quoting per dialect. */
const Q = {
  mssql: (s) => '[' + String(s).replace(/]/g, ']]') + ']',
  postgres: (s) => '"' + String(s).replace(/"/g, '""') + '"',
  mysql: (s) => '`' + String(s).replace(/`/g, '``') + '`',
  oracle: (s) => '"' + String(s).replace(/"/g, '""') + '"',
  sqlite: (s) => '"' + String(s).replace(/"/g, '""') + '"',
};
export function qualified(dialect, ...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p) => Q[dialect](p))
    .join('.');
}

/**
 * Rewrite report-style parameter markers (@name or :name) in a SQL text to the driver's native style.
 * Only names listed in `names` are replaced; markers inside strings / comments / quoted identifiers are ignored.
 *   mssql -> @name   postgres -> $1..$n   mysql -> ?   oracle/sqlite -> :name
 * Returns the rewritten SQL and the order in which values must be supplied (for positional styles).
 */
export function translateParams(sql, names, dialect) {
  const known = new Map(names.map((n) => [n.toLowerCase(), n]));
  const order = [];
  const pgIndex = new Map();
  let out = '';
  let i = 0;
  const s = String(sql ?? '');
  const skipTo = (end, from) => {
    const j = s.indexOf(end, from);
    return j < 0 ? s.length : j + end.length;
  };
  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    let j = -1;
    if (two === '--') j = skipTo('\n', i);
    else if (two === '/*') j = skipTo('*/', i + 2);
    else if (c === "'") {
      j = i + 1;
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") break;
        else j++;
      }
      j = Math.min(s.length, j + 1);
    } else if (c === '"') j = skipTo('"', i + 1);
    else if (c === '`') j = skipTo('`', i + 1);
    else if (c === '[' && dialect === 'mssql') j = skipTo(']', i + 1);
    if (j > i) {
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if ((c === '@' || c === ':') && !/[\w:@$]/.test(s[i - 1] ?? '')) {
      const m = /^[A-Za-z_][\w]*/.exec(s.slice(i + 1));
      const name = m && known.get(m[0].toLowerCase());
      if (name) {
        if (dialect === 'postgres') {
          let idx = pgIndex.get(name);
          if (!idx) {
            order.push(name);
            idx = order.length;
            pgIndex.set(name, idx);
          }
          out += '$' + idx;
        } else if (dialect === 'mysql') {
          order.push(name);
          out += '?';
        } else {
          if (!order.includes(name)) order.push(name);
          out += (dialect === 'mssql' ? '@' : ':') + name;
        }
        i += 1 + m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { sql: out, order };
}

/** Convert a value sent by the client ({type, value}) to a JS value for binding. */
export function bindValue(p) {
  if (!p || p.value === null || p.value === undefined || p.value === '') return p?.type === 'string' ? (p.value ?? null) : null;
  switch (p.type) {
    case 'number': {
      const n = Number(p.value);
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return p.value === true || String(p.value).toLowerCase() === 'true' || p.value === 1 || p.value === '1';
    case 'date': {
      const d = new Date(p.value);
      return isNaN(d.getTime()) ? null : d;
    }
    default:
      return String(p.value);
  }
}

const pad = (n, l = 2) => String(n).padStart(l, '0');
/** Date -> local "YYYY-MM-DDTHH:mm:ss[.SSS]" (no timezone) so dates do not shift between server and browser. */
export function localIso(d) {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.getMilliseconds() ? base + '.' + pad(d.getMilliseconds(), 3) : base;
}

function bufferValue(b) {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  const sig = (...xs) => xs.every((x, k) => u[k] === x);
  let mime = null;
  if (sig(0x89, 0x50, 0x4e, 0x47)) mime = 'image/png';
  else if (sig(0xff, 0xd8, 0xff)) mime = 'image/jpeg';
  else if (sig(0x47, 0x49, 0x46)) mime = 'image/gif';
  else if (sig(0x42, 0x4d)) mime = 'image/bmp';
  else if (sig(0x52, 0x49, 0x46, 0x46) && u[8] === 0x57 && u[9] === 0x45) mime = 'image/webp';
  if (mime && u.length < 8 * 1024 * 1024) return `data:${mime};base64,` + Buffer.from(u).toString('base64');
  return '0x' + Buffer.from(u.slice(0, 32)).toString('hex') + (u.length > 32 ? '…' : '');
}

export function normValue(v, type) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : localIso(v);
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return bufferValue(v);
  if (type === 'number' && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  if (type === 'boolean' && (v === 0 || v === 1)) return v === 1;
  return v;
}

/**
 * Build the API result from column metadata + array rows.
 * Duplicate / empty column names get unique names (Name, Name_1, Column3 ...).
 */
export function buildResult(columns, rows, maxRows) {
  const used = new Set();
  const names = columns.map((c, i) => {
    const base = String(c.name ?? '').trim() || 'Column' + (i + 1);
    let n = base;
    let k = 1;
    while (used.has(n.toLowerCase())) n = `${base}_${k++}`;
    used.add(n.toLowerCase());
    return n;
  });
  const truncated = rows.length > maxRows;
  const out = rows.slice(0, maxRows).map((r) => {
    const o = {};
    names.forEach((n, i) => (o[n] = normValue(r[i], columns[i].type)));
    return o;
  });
  return { columns: names.map((n, i) => ({ name: n, type: columns[i].type ?? null, dbType: columns[i].dbType ?? null })), rows: out, truncated };
}

/** Map a database type name to a report field type. */
export function fieldType(dbType) {
  const t = String(dbType ?? '').toLowerCase();
  if (!t) return null;
  if (/^(bit|bool|boolean)$/.test(t)) return 'boolean';
  if (/int|dec|numeric|number|money|float|real|double|serial|year/.test(t)) return 'number';
  if (/date|timestamp|datetime/.test(t)) return 'date';
  return 'string';
}

export const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog', 'mysql', 'sys', 'performance_schema']);
