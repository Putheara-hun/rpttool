// Data source loading: sample sets, inline JSON / CSV, and remote URLs.
import type { DataSourceDef, FieldDef, FieldType, Row } from '../model/types';
import { isDate, looksLikeIsoDate, parseDate } from '../engine/format';
import { SAMPLE_SETS } from './sampleData';
import type { EvalContext } from '../engine/expression';
import { executeSql, resolveSqlParams } from './dbApi';

export function parseCsv(text: string): Row[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delims = [',', ';', '\t', '|'];
  const delim = delims.reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const records: string[][] = [];
  let field = '';
  let rec: string[] = [];
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') q = true;
    else if (c === delim) {
      rec.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      rec.push(field);
      field = '';
      if (rec.length > 1 || rec[0] !== '') records.push(rec);
      rec = [];
    } else field += c;
  }
  if (field !== '' || rec.length) {
    rec.push(field);
    records.push(rec);
  }
  if (!records.length) return [];
  const header = records[0].map((h, i) => h.trim() || 'Column' + (i + 1));
  return records.slice(1).map((r) => {
    const o: Row = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ''));
    return o;
  });
}

function valueType(v: unknown): FieldType | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (isDate(v)) return 'date';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s !== '' && !isNaN(Number(s)) && !/^0\d/.test(s)) return 'number';
    if (/^(true|false)$/i.test(s)) return 'boolean';
    if (looksLikeIsoDate(s)) return 'date';
  }
  return 'string';
}

export function inferFields(rows: Row[]): FieldDef[] {
  const types = new Map<string, Set<FieldType>>();
  const order: string[] = [];
  const visit = (key: string, v: unknown, depth: number) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !isDate(v) && depth < 2) {
      for (const [k, x] of Object.entries(v as object)) visit(key + '.' + k, x, depth + 1);
      return;
    }
    if (!types.has(key)) {
      types.set(key, new Set());
      order.push(key);
    }
    const t = Array.isArray(v) ? 'string' : valueType(v);
    if (t) types.get(key)!.add(t);
  };
  for (const row of rows.slice(0, 300)) for (const [k, v] of Object.entries(row)) visit(k, v, 0);
  return order.map((name) => {
    const s = types.get(name)!;
    let type: FieldType = 'string';
    if (s.size === 1) type = [...s][0];
    return { name, type };
  });
}

function setPath(o: any, path: string, v: unknown) {
  const parts = path.split('.');
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') return;
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
}
function getPath(o: any, path: string) {
  return path.split('.').reduce((c, p) => (c == null ? c : c[p]), o);
}

/** Convert string values to the declared field types. */
export function coerceRows(rows: Row[], fields: FieldDef[]): Row[] {
  return rows.map((row) => {
    const o: Row = { ...row };
    for (const f of fields) {
      const v = f.name.includes('.') ? getPath(o, f.name) : o[f.name];
      let nv: unknown = v;
      if (v === undefined) continue;
      if (f.type === 'number' && typeof v === 'string') nv = v.trim() === '' ? null : Number(v);
      else if (f.type === 'boolean' && typeof v === 'string') nv = /^(true|1|yes)$/i.test(v.trim());
      else if (f.type === 'date' && !isDate(v)) nv = parseDate(v);
      else if (f.type === 'string' && v !== null && typeof v !== 'string') nv = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (nv !== v) {
        if (f.name.includes('.')) setPath(o, f.name, nv);
        else o[f.name] = nv;
      }
    }
    return o;
  });
}

export function rowsFromJson(text: string, path?: string): Row[] {
  let data: any = JSON.parse(text);
  if (path) data = getPath(data, path);
  if (Array.isArray(data)) return data.map((x) => (x && typeof x === 'object' ? x : { value: x }));
  if (data && typeof data === 'object') {
    const arr = Object.values(data).find(Array.isArray);
    if (arr) return (arr as any[]).map((x) => (x && typeof x === 'object' ? x : { value: x }));
    return [data];
  }
  return [];
}

export function rowsFromText(text: string, kind: 'json' | 'csv', path?: string): Row[] {
  return kind === 'csv' ? parseCsv(text) : rowsFromJson(text, path);
}

/** Load the rows of a data source (async for URLs and databases). */
export async function loadDataSource(ds: DataSourceDef, ctx?: Partial<EvalContext>, maxRows?: number): Promise<Row[]> {
  let rows: Row[] = [];
  switch (ds.kind) {
    case 'sql': {
      if (!ds.sql?.connectionId) return [];
      const r = await executeSql(ds.sql, resolveSqlParams(ds.sql, ctx ?? {}), maxRows ?? (ds.sql.maxRows || 100000));
      rows = r.rows;
      break;
    }
    case 'sample':
      rows = SAMPLE_SETS[ds.sample ?? '']?.load() ?? [];
      return rows;
    case 'json':
    case 'csv':
      rows = rowsFromText(ds.content ?? '', ds.kind, ds.path);
      break;
    case 'url': {
      if (!ds.url) return [];
      const res = await fetch(ds.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} loading ${ds.url}`);
      const text = await res.text();
      const isCsv = /\.csv(\?|$)/i.test(ds.url) || (res.headers.get('content-type') ?? '').includes('csv');
      rows = rowsFromText(text, isCsv ? 'csv' : 'json', ds.path);
      break;
    }
  }
  const fields = ds.fields?.length ? ds.fields : inferFields(rows);
  return coerceRows(rows, fields);
}

export function loadDataSourceSync(ds: DataSourceDef): Row[] | null {
  if (ds.kind === 'url' || ds.kind === 'sql') return null;
  if (ds.kind === 'sample') return SAMPLE_SETS[ds.sample ?? '']?.load() ?? [];
  try {
    const rows = rowsFromText(ds.content ?? '', ds.kind, ds.path);
    return coerceRows(rows, ds.fields?.length ? ds.fields : inferFields(rows));
  } catch {
    return [];
  }
}
