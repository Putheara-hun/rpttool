// PostgreSQL (pg, pure JavaScript).
import { ApiError, bindValue, buildResult, fieldType, qualified, translateParams } from '../common.mjs';

let lib;
async function load() {
  if (!lib) {
    lib = (await import('pg')).default;
    const T = lib.types;
    T.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' (no timezone shift)
    T.setTypeParser(1114, (v) => v.replace(' ', 'T')); // timestamp without time zone
    T.setTypeParser(20, (v) => Number(v)); // int8
    T.setTypeParser(1700, (v) => Number(v)); // numeric
  }
  return lib;
}
const pools = new Map();

const OID_NUM = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);
const OID_DATE = new Set([1082, 1114, 1184]);
const oidType = (oid) => (OID_NUM.has(oid) ? 'number' : OID_DATE.has(oid) ? 'date' : oid === 16 ? 'boolean' : 'string');

async function pool(c) {
  const pg = await load();
  const cfg = {
    host: c.host || 'localhost',
    port: Number(c.port) || 5432,
    database: c.database || undefined,
    user: c.user || undefined,
    password: c.password ?? '',
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    max: 4,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 60000,
  };
  const key = JSON.stringify(cfg);
  const hit = pools.get(c.id);
  if (hit && hit.key === key) return hit.pool;
  if (hit) hit.pool.end().catch(() => {});
  const p = new pg.Pool(cfg);
  p.on('error', () => {});
  pools.set(c.id, { key, pool: p });
  return p;
}

async function run(c, fn) {
  const p = await pool(c);
  let client;
  try {
    client = await p.connect();
  } catch (e) {
    pools.delete(c.id);
    p.end().catch(() => {});
    throw e;
  }
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export default {
  id: 'postgres',
  test(c) {
    return run(c, async (cl) => String((await cl.query('SELECT version() AS v')).rows[0].v).split(',')[0]);
  },
  schema(c) {
    return run(c, async (cl) => {
      const t = await cl.query(
        `SELECT table_schema AS s, table_name AS n, table_type AS t FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'
         UNION ALL SELECT schemaname, matviewname, 'VIEW' FROM pg_matviews
         ORDER BY 1, 2`,
      );
      const r = await cl.query(
        `SELECT n.nspname AS s, p.proname AS n, p.prokind AS k, p.proretset AS rs,
                pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res,
                p.proname || '_' || p.oid AS spec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
           AND p.prokind IN ('f', 'p')
           AND COALESCE(pg_get_function_result(p.oid), '') NOT IN ('trigger', 'event_trigger')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
         ORDER BY 1, 2`,
      );
      return {
        tables: t.rows.filter((x) => x.t === 'BASE TABLE').map((x) => ({ schema: x.s, name: x.n })),
        views: t.rows.filter((x) => x.t === 'VIEW').map((x) => ({ schema: x.s, name: x.n })),
        procedures: r.rows.filter((x) => x.k === 'p').map((x) => ({ schema: x.s, name: x.n, specific: x.spec, signature: x.args })),
        functions: r.rows
          .filter((x) => x.k === 'f')
          .map((x) => ({ schema: x.s, name: x.n, specific: x.spec, signature: x.args, returnsTable: x.rs || /^TABLE\(/i.test(x.res ?? ''), returnType: x.res })),
      };
    });
  },
  params(c, o) {
    return run(c, async (cl) => {
      let r;
      if (o.specific) {
        r = await cl.query(
          `SELECT parameter_name AS n, data_type AS t, parameter_mode AS m, ordinal_position AS pos FROM information_schema.parameters
           WHERE specific_schema = $1 AND specific_name = $2 ORDER BY ordinal_position`,
          [o.schema, o.specific],
        );
      } else {
        r = await cl.query(
          `SELECT parameter_name AS n, data_type AS t, parameter_mode AS m, ordinal_position AS pos FROM information_schema.parameters
           WHERE specific_schema = $1 AND specific_name = (SELECT specific_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_name = $2 LIMIT 1)
           ORDER BY ordinal_position`,
          [o.schema, o.name],
        );
      }
      return {
        params: r.rows
          .filter((x) => x.m !== 'OUT' && x.m !== 'TABLE')
          .map((x) => ({ name: x.n || 'p' + x.pos, dbType: x.t, type: fieldType(x.t) ?? 'string', mode: x.m === 'INOUT' ? 'INOUT' : 'IN' })),
      };
    });
  },
  execute(c, src, values, maxRows) {
    return run(c, async (cl) => {
      const obj = qualified('postgres', src.schema, src.name);
      const list = (src.params ?? []).map((x) => x.name);
      const posArgs = () => list.map((_, i) => '$' + (i + 1)).join(', ');
      const posVals = () => list.map((n) => bindValue(values[n]));
      let text;
      let vals = [];
      switch (src.mode) {
        case 'table':
        case 'view':
          text = `SELECT * FROM ${obj} LIMIT ${maxRows + 1}`;
          break;
        case 'function':
          text = `SELECT * FROM ${obj}(${posArgs()}) LIMIT ${maxRows + 1}`;
          vals = posVals();
          break;
        case 'procedure':
          text = `CALL ${obj}(${posArgs()})`;
          vals = posVals();
          break;
        case 'query': {
          const t = translateParams(src.query, list, 'postgres');
          text = t.sql;
          vals = t.order.map((n) => bindValue(values[n]));
          break;
        }
        default:
          throw new ApiError('Unknown source mode ' + src.mode);
      }
      let res = await cl.query({ text, values: vals, rowMode: 'array' });
      if (Array.isArray(res)) res = [...res].reverse().find((x) => x.fields?.length) ?? res[res.length - 1];
      const columns = (res.fields ?? []).map((f) => ({ name: f.name, type: oidType(f.dataTypeID), dbType: String(f.dataTypeID) }));
      return buildResult(columns, res.rows ?? [], maxRows);
    });
  },
  close(id) {
    const hit = pools.get(id);
    if (hit) hit.pool.end().catch(() => {});
    pools.delete(id);
  },
};
