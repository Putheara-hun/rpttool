// Oracle Database (node-oracledb in Thin mode: pure JavaScript, no Oracle Client needed).
import { ApiError, bindValue, buildResult, fieldType, qualified, translateParams } from '../common.mjs';

let lib;
async function load() {
  if (!lib) {
    lib = (await import('oracledb')).default;
    lib.fetchAsString = [lib.CLOB];
    lib.fetchAsBuffer = [lib.BLOB];
  }
  return lib;
}
const pools = new Map();
const TABLE_TYPES = new Set(['TABLE', 'VARRAY', 'PL/SQL TABLE', 'OBJECT', 'REF CURSOR']);

async function connect(c) {
  const ora = await load();
  const connectString = c.connectString || `${c.host || 'localhost'}:${Number(c.port) || 1521}/${c.database || 'XEPDB1'}`;
  const cfg = { user: c.user, password: c.password ?? '', connectString, poolMin: 0, poolMax: 4, poolIncrement: 1, poolTimeout: 60 };
  const key = JSON.stringify(cfg);
  let hit = pools.get(c.id);
  if (!hit || hit.key !== key) {
    if (hit) hit.ready.then((p) => p.close(0)).catch(() => {});
    hit = { key, ready: ora.createPool(cfg) };
    pools.set(c.id, hit);
  }
  try {
    const p = await hit.ready;
    return await p.getConnection();
  } catch (e) {
    pools.delete(c.id);
    throw e;
  }
}

async function withConn(c, fn) {
  const conn = await connect(c);
  try {
    return await fn(conn, await load());
  } finally {
    await conn.close().catch(() => {});
  }
}

const owner = async (c, conn) => (c.schema ? String(c.schema).toUpperCase() : (await conn.execute('SELECT USER FROM DUAL')).rows[0][0]);
const metaCols = (meta) => (meta ?? []).map((m) => ({ name: m.name, type: fieldType(m.dbTypeName), dbType: m.dbTypeName }));

async function fromCursor(rs, maxRows) {
  try {
    const rows = await rs.getRows(maxRows + 1);
    return buildResult(metaCols(rs.metaData), rows, maxRows);
  } finally {
    await rs.close().catch(() => {});
  }
}

export default {
  id: 'oracle',
  test(c) {
    return withConn(c, async (conn) => 'Oracle Database ' + (conn.oracleServerVersionString ?? ''));
  },
  schema(c) {
    return withConn(c, async (conn) => {
      const o = await owner(c, conn);
      const objs = (
        await conn.execute(
          `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS
           WHERE OWNER = :o AND OBJECT_TYPE IN ('TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION') AND OBJECT_NAME NOT LIKE 'BIN$%'
           ORDER BY OBJECT_TYPE, OBJECT_NAME`,
          { o },
        )
      ).rows;
      const pkg = (
        await conn.execute(`SELECT OBJECT_NAME, PROCEDURE_NAME FROM ALL_PROCEDURES WHERE OWNER = :o AND OBJECT_TYPE = 'PACKAGE' AND PROCEDURE_NAME IS NOT NULL ORDER BY 1, 2`, { o })
      ).rows;
      const ret = new Map(
        (await conn.execute(`SELECT NVL(PACKAGE_NAME, '-'), OBJECT_NAME, DATA_TYPE FROM ALL_ARGUMENTS WHERE OWNER = :o AND POSITION = 0 AND DATA_LEVEL = 0`, { o })).rows.map((r) => [
          r[0] + '|' + r[1],
          r[2],
        ]),
      );
      const fn = (schema, name, p) => {
        const rt = ret.get((p ?? '-') + '|' + name);
        return { schema, name, pkg: p, returnType: rt, returnsTable: TABLE_TYPES.has(rt) };
      };
      const out = {
        tables: objs.filter((r) => r[2] === 'TABLE').map((r) => ({ schema: r[0], name: r[1] })),
        views: objs.filter((r) => r[2] === 'VIEW').map((r) => ({ schema: r[0], name: r[1] })),
        procedures: objs.filter((r) => r[2] === 'PROCEDURE').map((r) => ({ schema: r[0], name: r[1] })),
        functions: objs.filter((r) => r[2] === 'FUNCTION').map((r) => fn(r[0], r[1])),
      };
      for (const [p, name] of pkg) {
        if (ret.has(p + '|' + name)) out.functions.push(fn(o, name, p));
        else out.procedures.push({ schema: o, name, pkg: p });
      }
      return out;
    });
  },
  params(c, ob) {
    return withConn(c, async (conn) => {
      const rows = (
        await conn.execute(
          `SELECT ARGUMENT_NAME, DATA_TYPE, IN_OUT, POSITION FROM ALL_ARGUMENTS
           WHERE OWNER = :o AND OBJECT_NAME = :n AND NVL(PACKAGE_NAME, '-') = NVL(:p, '-') AND DATA_LEVEL = 0
             AND NVL(OVERLOAD, '0') = (SELECT NVL(MIN(OVERLOAD), '0') FROM ALL_ARGUMENTS WHERE OWNER = :o AND OBJECT_NAME = :n AND NVL(PACKAGE_NAME, '-') = NVL(:p, '-'))
           ORDER BY POSITION, SEQUENCE`,
          { o: ob.schema, n: ob.name, p: ob.pkg ?? null },
        )
      ).rows;
      const ret = rows.find((r) => r[3] === 0);
      return {
        returnType: ret?.[1],
        params: rows
          .filter((r) => r[3] > 0 && r[0])
          .map((r) => ({ name: r[0], dbType: r[1], type: r[1] === 'REF CURSOR' ? 'string' : (fieldType(r[1]) ?? 'string'), mode: r[2] === 'IN/OUT' ? 'INOUT' : r[2] })),
      };
    });
  },
  execute(c, src, values, maxRows) {
    return withConn(c, async (conn, ora) => {
      const opts = { outFormat: ora.OUT_FORMAT_ARRAY, maxRows: maxRows + 1 };
      const obj = qualified('oracle', src.schema, src.pkg, src.name);
      const prms = src.params ?? [];
      switch (src.mode) {
        case 'table':
        case 'view': {
          const r = await conn.execute(`SELECT * FROM ${obj} WHERE ROWNUM <= ${maxRows + 1}`, [], opts);
          return buildResult(metaCols(r.metaData), r.rows, maxRows);
        }
        case 'function': {
          const binds = {};
          const args = prms.map((p, i) => ((binds['b' + i] = bindValue(values[p.name])), ':b' + i)).join(', ');
          const rt = String(src.returnType ?? '').toUpperCase();
          if (rt === 'REF CURSOR') {
            binds.rt_cur = { dir: ora.BIND_OUT, type: ora.CURSOR };
            const r = await conn.execute(`BEGIN :rt_cur := ${obj}(${args}); END;`, binds);
            return fromCursor(r.outBinds.rt_cur, maxRows);
          }
          const sql = TABLE_TYPES.has(rt) ? `SELECT * FROM TABLE(${obj}(${args})) WHERE ROWNUM <= ${maxRows + 1}` : `SELECT ${obj}(${args}) AS VALUE FROM DUAL`;
          const r = await conn.execute(sql, binds, opts);
          return buildResult(metaCols(r.metaData), r.rows, maxRows);
        }
        case 'procedure': {
          const binds = {};
          const cursors = [];
          const outs = [];
          const args = prms
            .map((p, i) => {
              const b = 'b' + i;
              if (p.dbType === 'REF CURSOR') {
                binds[b] = { dir: ora.BIND_OUT, type: ora.CURSOR };
                cursors.push(b);
              } else if (p.mode === 'OUT') {
                binds[b] = { dir: ora.BIND_OUT, type: ora.STRING, maxSize: 4000 };
                outs.push([p.name, b]);
              } else if (p.mode === 'INOUT') {
                binds[b] = { dir: ora.BIND_INOUT, val: bindValue(values[p.name]), maxSize: 4000 };
                outs.push([p.name, b]);
              } else binds[b] = bindValue(values[p.name]);
              return ':' + b;
            })
            .join(', ');
          const r = await conn.execute(`BEGIN ${obj}(${args}); END;`, binds);
          if (cursors.length) {
            for (const extra of cursors.slice(1)) await r.outBinds[extra]?.close().catch(() => {});
            return fromCursor(r.outBinds[cursors[0]], maxRows);
          }
          return buildResult(
            outs.map(([n]) => ({ name: n, type: null })),
            outs.length ? [outs.map(([, b]) => r.outBinds[b])] : [],
            maxRows,
          );
        }
        case 'query': {
          let text = String(src.query ?? '').trim();
          if (!/^(begin|declare)\b/i.test(text)) text = text.replace(/;\s*$/, '');
          const t = translateParams(text, prms.map((p) => p.name), 'oracle');
          const binds = Object.fromEntries(t.order.map((n) => [n, bindValue(values[n])]));
          const r = await conn.execute(t.sql, binds, opts);
          return buildResult(metaCols(r.metaData), r.rows ?? [], maxRows);
        }
        default:
          throw new ApiError('Unknown source mode ' + src.mode);
      }
    });
  },
  close(id) {
    const hit = pools.get(id);
    if (hit) hit.ready.then((p) => p.close(0)).catch(() => {});
    pools.delete(id);
  },
};
