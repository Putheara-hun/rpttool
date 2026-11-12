// SQLite database files (Node's built-in node:sqlite, opened read-only).
import fs from 'node:fs';
import { ApiError, buildResult, localIso, qualified, translateParams, bindValue } from '../common.mjs';

const dbs = new Map();

async function open(c) {
  const file = String(c.file || c.database || '').trim();
  if (!file) throw new ApiError('Enter the path of the SQLite database file.');
  if (!fs.existsSync(file)) throw new ApiError('SQLite file not found: ' + file);
  const hit = dbs.get(c.id);
  if (hit && hit.file === file) return hit.db;
  if (hit) hit.db.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  dbs.set(c.id, { file, db });
  return db;
}

const sqliteValue = (p) => {
  const v = bindValue(p);
  if (v instanceof Date) return localIso(v).replace('T', ' ');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};

function typeFromDecl(t) {
  const s = String(t ?? '').toLowerCase();
  if (!s) return null;
  if (/int|real|floa|doub|num|dec/.test(s)) return 'number';
  if (/date|time/.test(s)) return 'date';
  if (/bool/.test(s)) return 'boolean';
  return 'string';
}

export default {
  id: 'sqlite',
  async test(c) {
    const db = await open(c);
    return 'SQLite ' + db.prepare('select sqlite_version() as v').get().v;
  },
  async schema(c) {
    const db = await open(c);
    const rows = db.prepare("SELECT name AS n, type AS t FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return {
      tables: rows.filter((r) => r.t === 'table').map((r) => ({ schema: '', name: r.n })),
      views: rows.filter((r) => r.t === 'view').map((r) => ({ schema: '', name: r.n })),
      procedures: [],
      functions: [],
    };
  },
  async params() {
    return { params: [] };
  },
  async execute(c, src, values, maxRows) {
    const db = await open(c);
    let sql;
    let binds = {};
    if (src.mode === 'table' || src.mode === 'view') sql = `SELECT * FROM ${qualified('sqlite', src.name)} LIMIT ${maxRows + 1}`;
    else if (src.mode === 'query') {
      const t = translateParams(src.query, (src.params ?? []).map((p) => p.name), 'sqlite');
      sql = t.sql;
      binds = Object.fromEntries(t.order.map((n) => [n, sqliteValue(values[n])]));
    } else throw new ApiError('SQLite has no stored procedures or functions; use a table, view or SQL query.');
    const stmt = db.prepare(sql);
    const cols = stmt.columns ? stmt.columns() : [];
    const rows = [];
    for (const r of stmt.iterate(binds)) {
      rows.push(r);
      if (rows.length > maxRows) break;
    }
    const names = cols.length ? cols.map((x) => x.name) : Object.keys(rows[0] ?? {});
    const types = cols.map((x) => typeFromDecl(x.type));
    return buildResult(
      names.map((n, i) => ({ name: n, type: types[i] ?? null })),
      rows.map((r) => names.map((n) => r[n])),
      maxRows,
    );
  },
  close(id) {
    const hit = dbs.get(id);
    if (hit) hit.db.close();
    dbs.delete(id);
  },
};
