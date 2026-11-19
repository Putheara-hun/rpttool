// Microsoft SQL Server (mssql / tedious, pure JavaScript).
import { ApiError, bindValue, buildResult, fieldType, qualified, translateParams } from '../common.mjs';

let lib;
const load = async () => (lib ??= (await import('mssql')).default);
const pools = new Map();

/** Accept SSMS-style "server,port" / "server\instance" and ignore values in Instance that are not instance names. */
export function resolveTarget(c) {
  let host = String(c.host || 'localhost').trim();
  let port = Number(c.port) || 1433;
  let instance = String(c.instance || '').trim();
  const hp = /^(.*?)\s*,\s*(\d+)$/.exec(host);
  if (hp) {
    host = hp[1];
    port = Number(hp[2]);
  }
  const hb = host.indexOf('\\');
  if (hb > 0) {
    instance = instance || host.slice(hb + 1);
    host = host.slice(0, hb);
  }
  const ip = /^(.*?)\s*,\s*(\d+)$/.exec(instance);
  if (ip) {
    port = Number(ip[2]);
    instance = '';
  }
  if (instance.includes('\\')) instance = instance.slice(instance.lastIndexOf('\\') + 1);
  if (/[.:\s]/.test(instance) || instance.toLowerCase() === host.toLowerCase()) instance = '';
  return { host, port, instance };
}

function config(c) {
  const t = resolveTarget(c);
  const cfg = {
    server: t.host,
    database: c.database || undefined,
    options: {
      encrypt: !!c.encrypt,
      trustServerCertificate: c.trustServerCertificate !== false,
      instanceName: t.instance || undefined,
      useUTC: false,
      enableArithAbort: true,
    },
    connectionTimeout: 15000,
    requestTimeout: 300000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 60000 },
  };
  if (!t.instance) cfg.port = t.port;
  if (c.auth === 'ntlm') cfg.authentication = { type: 'ntlm', options: { domain: c.domain || '', userName: c.user || '', password: c.password || '' } };
  else {
    cfg.user = c.user;
    cfg.password = c.password ?? '';
  }
  return cfg;
}

async function pool(c) {
  const sql = await load();
  const key = JSON.stringify(config(c));
  const hit = pools.get(c.id);
  if (hit && hit.key === key && !hit.failed) {
    await hit.ready;
    return hit.pool;
  }
  if (hit) hit.pool.close().catch(() => {});
  const p = new sql.ConnectionPool(config(c));
  p.on('error', () => {});
  const entry = { key, pool: p, ready: p.connect(), failed: false };
  pools.set(c.id, entry);
  try {
    await entry.ready;
  } catch (e) {
    entry.failed = true;
    pools.delete(c.id);
    throw e;
  }
  return p;
}

const colType = (col) => fieldType(col?.type?.declaration ?? col?.type?.name ?? '');

/** report parameter type -> a SQL type for sp_describe_first_result_set's @params */
const DECL = { number: 'decimal(38, 10)', date: 'datetime2', boolean: 'bit', string: 'nvarchar(4000)' };

/** rows of sys.dm_exec_describe_first_result_set(_for_object) -> columns, or the reason it could not describe */
function describedColumns(rows) {
  const err = rows.find((x) => x.error_message);
  if (err) return { columns: [], note: String(err.error_message) };
  const columns = rows
    .filter((x) => !x.is_hidden && x.column_ordinal != null)
    .sort((a, b) => a.column_ordinal - b.column_ordinal)
    .map((x) => ({ name: x.name ?? '', type: fieldType(x.system_type_name), dbType: x.system_type_name }));
  return { columns };
}

/**
 * Last resort for procedures SQL Server cannot describe without running them (temp tables, dynamic SQL):
 * run it inside a transaction that is always rolled back, take the first result set's columns and cancel the rest.
 */
async function columnsByRunning(sql, p, obj, src, values) {
  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    const req = new sql.Request(tx);
    req.stream = true;
    for (const prm of src.params ?? []) {
      if (prm.mode === 'OUT' || prm.mode === 'INOUT') req.output(prm.name, sql.NVarChar(sql.MAX), prm.mode === 'INOUT' ? bindValue(values[prm.name]) : undefined);
      else req.input(prm.name, bindValue(values[prm.name]));
    }
    return await new Promise((resolve, reject) => {
      let got = null;
      req.on('recordset', (columns) => {
        if (got) return;
        const list = Object.values(columns ?? {}).sort((a, b) => a.index - b.index);
        if (!list.length) return;
        got = list.map((col) => ({ name: col.name, type: colType(col), dbType: col.type?.declaration }));
        req.cancel();
      });
      req.on('error', (e) => (got ? resolve(got) : reject(e)));
      req.on('done', () => resolve(got ?? []));
      req.execute(obj);
    });
  } finally {
    await tx.rollback().catch(() => {});
  }
}

function pickRecordset(result) {
  const sets = result.recordsets ?? [];
  const metas = result.columns ?? [];
  for (let k = 0; k < sets.length; k++) {
    let cols = Array.isArray(metas[k]) ? metas[k] : null;
    if (!cols && sets[k]?.columns) cols = Object.values(sets[k].columns).sort((a, b) => a.index - b.index);
    if (cols && cols.length) {
      const rows = sets[k].map((r) => (Array.isArray(r) ? r : cols.map((c) => r[c.name])));
      return { columns: cols.map((c) => ({ name: c.name, type: colType(c), dbType: c.type?.declaration })), rows };
    }
  }
  return { columns: [], rows: [] };
}

export default {
  id: 'mssql',
  async test(c) {
    const r = await (await pool(c)).request().query('SELECT @@VERSION AS v');
    return String(r.recordset[0].v).split('\n')[0].trim();
  },
  async schema(c) {
    const p = await pool(c);
    const t = await p.request().query('SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t FROM INFORMATION_SCHEMA.TABLES ORDER BY 1, 2');
    const r = await p.request().query('SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS n, ROUTINE_TYPE AS t, DATA_TYPE AS dt FROM INFORMATION_SCHEMA.ROUTINES ORDER BY 1, 2');
    return {
      tables: t.recordset.filter((x) => x.t === 'BASE TABLE').map((x) => ({ schema: x.s, name: x.n })),
      views: t.recordset.filter((x) => x.t === 'VIEW').map((x) => ({ schema: x.s, name: x.n })),
      procedures: r.recordset.filter((x) => x.t === 'PROCEDURE').map((x) => ({ schema: x.s, name: x.n })),
      functions: r.recordset.filter((x) => x.t === 'FUNCTION').map((x) => ({ schema: x.s, name: x.n, returnsTable: x.dt === 'TABLE', returnType: x.dt })),
    };
  },
  async params(c, o) {
    const sql = await load();
    const p = await pool(c);
    const r = await p
      .request()
      .input('s', sql.NVarChar, o.schema)
      .input('n', sql.NVarChar, o.name)
      .query('SELECT PARAMETER_NAME AS n, DATA_TYPE AS t, PARAMETER_MODE AS m, IS_RESULT AS r FROM INFORMATION_SCHEMA.PARAMETERS WHERE SPECIFIC_SCHEMA = @s AND SPECIFIC_NAME = @n ORDER BY ORDINAL_POSITION');
    return {
      params: r.recordset
        .filter((x) => x.r !== 'YES' && x.n)
        .map((x) => ({ name: String(x.n).replace(/^@/, ''), dbType: x.t, type: fieldType(x.t) ?? 'string', mode: x.m === 'INOUT' ? 'INOUT' : x.m === 'OUT' ? 'OUT' : 'IN' })),
    };
  },
  /**
   * The columns a source returns, read from its definition without running it (no rows):
   * tables / views (TOP 0), table functions (ROUTINE_COLUMNS), procedures and queries (SQL Server's
   * describe-first-result-set). A procedure it cannot describe is run in a rolled-back transaction.
   */
  async describe(c, src, values) {
    const sql = await load();
    const p = await pool(c);
    const obj = qualified('mssql', src.schema, src.name);
    switch (src.mode) {
      case 'table':
      case 'view': {
        const r = await p.request().query(`SELECT TOP (0) * FROM ${obj}`);
        const cols = Object.values(r.recordset?.columns ?? {}).sort((a, b) => a.index - b.index);
        return { columns: cols.map((col) => ({ name: col.name, type: colType(col), dbType: col.type?.declaration })), how: 'definition' };
      }
      case 'function': {
        if (!src.returnsTable) return { columns: [{ name: 'Value', type: fieldType(src.returnType), dbType: src.returnType }], how: 'definition' };
        const r = await p
          .request()
          .input('s', sql.NVarChar, src.schema)
          .input('n', sql.NVarChar, src.name)
          .query('SELECT COLUMN_NAME AS n, DATA_TYPE AS t FROM INFORMATION_SCHEMA.ROUTINE_COLUMNS WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @n ORDER BY ORDINAL_POSITION');
        return { columns: r.recordset.map((x) => ({ name: x.n, type: fieldType(x.t), dbType: x.t })), how: 'definition' };
      }
      case 'procedure': {
        const r = await p
          .request()
          .input('o', sql.NVarChar, obj)
          .query('SELECT name, system_type_name, column_ordinal, is_hidden, error_message FROM sys.dm_exec_describe_first_result_set_for_object(OBJECT_ID(@o), 0)');
        const d = describedColumns(r.recordset);
        if (d.columns.length || !d.note) return { ...d, how: 'definition' };
        return { columns: await columnsByRunning(sql, p, obj, src, values), how: 'run', note: d.note };
      }
      case 'query': {
        const list = src.params ?? [];
        const t = translateParams(src.query, list.map((x) => x.name), 'mssql');
        const typeOf = (n) => list.find((x) => x.name === n)?.type ?? values[n]?.type ?? 'string';
        const decl = t.order.map((n) => `@${n} ${DECL[typeOf(n)] ?? DECL.string}`).join(', ');
        const r = await p
          .request()
          .input('q', sql.NVarChar(sql.MAX), t.sql)
          .input('d', sql.NVarChar(sql.MAX), decl || null)
          .query('SELECT name, system_type_name, column_ordinal, is_hidden, error_message FROM sys.dm_exec_describe_first_result_set(@q, @d, 0)');
        return { ...describedColumns(r.recordset), how: 'definition' };
      }
      default:
        throw new ApiError('Unknown source mode ' + src.mode);
    }
  },
  async execute(c, src, values, maxRows) {
    const sql = await load();
    const p = await pool(c);
    const req = p.request();
    req.arrayRowMode = true;
    const input = (name) => req.input(name, bindValue(values[name]));
    const obj = qualified('mssql', src.schema, src.name);
    let result;
    switch (src.mode) {
      case 'table':
      case 'view':
        result = await req.query(`SELECT TOP (${maxRows + 1}) * FROM ${obj}`);
        break;
      case 'function': {
        const names = (src.params ?? []).map((x) => x.name);
        names.forEach(input);
        const args = names.map((n) => '@' + n).join(', ');
        result = await req.query(src.returnsTable ? `SELECT TOP (${maxRows + 1}) * FROM ${obj}(${args})` : `SELECT ${obj}(${args}) AS [Value]`);
        break;
      }
      case 'procedure':
        for (const prm of src.params ?? []) {
          if (prm.mode === 'OUT' || prm.mode === 'INOUT') req.output(prm.name, sql.NVarChar(sql.MAX), prm.mode === 'INOUT' ? bindValue(values[prm.name]) : undefined);
          else input(prm.name);
        }
        result = await req.execute(obj);
        break;
      case 'query': {
        const t = translateParams(src.query, (src.params ?? []).map((x) => x.name), 'mssql');
        t.order.forEach(input);
        result = await req.query(t.sql);
        break;
      }
      default:
        throw new ApiError('Unknown source mode ' + src.mode);
    }
    const rs = pickRecordset(result);
    if (!rs.columns.length && result.output && Object.keys(result.output).length) {
      const keys = Object.keys(result.output);
      return buildResult(keys.map((k) => ({ name: k, type: null })), [keys.map((k) => result.output[k])], maxRows);
    }
    return buildResult(rs.columns, rs.rows, maxRows);
  },
  close(id) {
    const hit = pools.get(id);
    if (hit) hit.pool.close().catch(() => {});
    pools.delete(id);
  },
};
