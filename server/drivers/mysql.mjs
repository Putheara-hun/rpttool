// MySQL / MariaDB (mysql2, pure JavaScript).
import { ApiError, bindValue, buildResult, fieldType, qualified, translateParams } from '../common.mjs';

let lib;
const load = async () => (lib ??= (await import('mysql2/promise')).default);
const pools = new Map();

// mysql2 column type codes
const NUM = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]);
const DATE = new Set([7, 10, 12, 14]);
const typeOf = (f) => (NUM.has(f.columnType ?? f.type) ? 'number' : DATE.has(f.columnType ?? f.type) ? 'date' : (f.columnType ?? f.type) === 16 ? 'boolean' : 'string');

async function pool(c) {
  const mysql = await load();
  const cfg = {
    host: c.host || 'localhost',
    port: Number(c.port) || 3306,
    user: c.user || undefined,
    password: c.password ?? '',
    database: c.database || undefined,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectionLimit: 4,
    connectTimeout: 15000,
  };
  const key = JSON.stringify(cfg);
  const hit = pools.get(c.id);
  if (hit && hit.key === key) return hit.pool;
  if (hit) hit.pool.end().catch(() => {});
  const p = mysql.createPool(cfg);
  pools.set(c.id, { key, pool: p });
  return p;
}

const schemaFilter = (c) =>
  c.database ? { where: '= DATABASE()', args: [] } : { where: "NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')", args: [] };

export default {
  id: 'mysql',
  async test(c) {
    const [rows] = await (await pool(c)).query('SELECT VERSION() AS v');
    return 'MySQL / MariaDB ' + rows[0].v;
  },
  async schema(c) {
    const p = await pool(c);
    const f = schemaFilter(c);
    const [t] = await p.query(`SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA ${f.where} ORDER BY 1, 2`);
    const [r] = await p.query(`SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS n, ROUTINE_TYPE AS t, DATA_TYPE AS dt FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA ${f.where} ORDER BY 1, 2`);
    return {
      tables: t.filter((x) => x.t === 'BASE TABLE').map((x) => ({ schema: x.s, name: x.n })),
      views: t.filter((x) => x.t === 'VIEW').map((x) => ({ schema: x.s, name: x.n })),
      procedures: r.filter((x) => x.t === 'PROCEDURE').map((x) => ({ schema: x.s, name: x.n })),
      functions: r.filter((x) => x.t === 'FUNCTION').map((x) => ({ schema: x.s, name: x.n, returnsTable: false, returnType: x.dt })),
    };
  },
  async params(c, o) {
    const [rows] = await (await pool(c)).query(
      'SELECT PARAMETER_NAME AS n, DATA_TYPE AS t, PARAMETER_MODE AS m FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ORDINAL_POSITION > 0 ORDER BY ORDINAL_POSITION',
      [o.schema, o.name],
    );
    return { params: rows.map((x) => ({ name: x.n, dbType: x.t, type: fieldType(x.t) ?? 'string', mode: x.m || 'IN' })) };
  },
  async execute(c, src, values, maxRows) {
    const p = await pool(c);
    const obj = qualified('mysql', src.schema, src.name);
    const prms = src.params ?? [];
    let sql;
    let vals = [];
    switch (src.mode) {
      case 'table':
      case 'view':
        sql = `SELECT * FROM ${obj} LIMIT ${maxRows + 1}`;
        break;
      case 'function':
        sql = `SELECT ${obj}(${prms.map(() => '?').join(', ')}) AS Value`;
        vals = prms.map((x) => bindValue(values[x.name]));
        break;
      case 'procedure': {
        const args = prms.map((x) => (x.mode === 'OUT' ? '@rt_' + x.name.replace(/\W/g, '') : '?'));
        vals = prms.filter((x) => x.mode !== 'OUT').map((x) => bindValue(values[x.name]));
        sql = `CALL ${obj}(${args.join(', ')})`;
        break;
      }
      case 'query': {
        const t = translateParams(src.query, prms.map((x) => x.name), 'mysql');
        sql = t.sql;
        vals = t.order.map((n) => bindValue(values[n]));
        break;
      }
      default:
        throw new ApiError('Unknown source mode ' + src.mode);
    }
    const [rows, fields] = await p.query({ sql, values: vals, rowsAsArray: true });
    // CALL returns several result sets; take the first one that has columns
    if (Array.isArray(fields) && Array.isArray(fields[0])) {
      for (let k = 0; k < fields.length; k++) {
        if (Array.isArray(fields[k]) && fields[k].length && Array.isArray(rows[k])) {
          return buildResult(fields[k].map((f) => ({ name: f.name, type: typeOf(f) })), rows[k], maxRows);
        }
      }
      return buildResult([], [], maxRows);
    }
    if (!Array.isArray(fields)) return buildResult([], [], maxRows);
    return buildResult(fields.map((f) => ({ name: f.name, type: typeOf(f) })), rows, maxRows);
  },
  close(id) {
    const hit = pools.get(id);
    if (hit) hit.pool.end().catch(() => {});
    pools.delete(id);
  },
};
