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
