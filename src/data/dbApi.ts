// Client for the local database API (server/api.mjs).
import type { FieldDef, FieldType, ParamType, Row, SqlSource } from '../model/types';
import { evalExpr, type EvalContext } from '../engine/expression';
import { isDate } from '../engine/format';

export type Provider = 'mssql' | 'postgres' | 'mysql' | 'oracle' | 'sqlite';

export const PROVIDERS: { id: Provider; label: string; port?: number; dbLabel: string }[] = [
  { id: 'mssql', label: 'Microsoft SQL Server', port: 1433, dbLabel: 'Database' },
  { id: 'oracle', label: 'Oracle Database', port: 1521, dbLabel: 'Service name' },
  { id: 'postgres', label: 'PostgreSQL', port: 5432, dbLabel: 'Database' },
  { id: 'mysql', label: 'MySQL / MariaDB', port: 3306, dbLabel: 'Database' },
  { id: 'sqlite', label: 'SQLite (database file)', dbLabel: 'File' },
];
export const providerLabel = (p?: string) => PROVIDERS.find((x) => x.id === p)?.label ?? p ?? '';

export interface DbConnection {
  id?: string;
  name: string;
  provider: Provider;
  host?: string;
  port?: number | string;
  instance?: string;
  database?: string;
  user?: string;
  password?: string;
  auth?: 'sql' | 'ntlm';
  domain?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
  file?: string;
  connectString?: string;
  schema?: string;
  savePassword?: boolean;
  hasPassword?: boolean;
  /** set up on the server (REPORTTOOL_CONNECTIONS): cannot be edited or deleted in the designer */
  fixed?: boolean;
}

export interface DbObject {
  schema: string;
  name: string;
  pkg?: string;
  specific?: string;
  signature?: string;
  returnsTable?: boolean;
  returnType?: string;
}
export interface DbSchema {
  tables: DbObject[];
  views: DbObject[];
  procedures: DbObject[];
  functions: DbObject[];
}
export interface DbParamInfo {
  name: string;
  type: ParamType;
  dbType?: string;
  mode?: string;
}
export interface DbResult {
  columns: { name: string; type: FieldType | null; dbType?: string | null }[];
  rows: Row[];
  truncated: boolean;
  ms: number;
}

export class DbError extends Error {
  status: number;
  needLogin?: boolean;
  missingConnection?: boolean;
  connectionId?: string;
  connectionName?: string;
  /** this website has no ReportTool server (static hosting): database features cannot work here */
  noService?: boolean;
  /** the server has a team password and this browser is not signed in */
  authRequired?: boolean;
  /** the database refused the saved login of this connection (wrong user / password, …) */
  authFailed?: boolean;
  constructor(message: string, status = 0, extra: any = {}) {
    super(message);
    this.status = status;
    this.noService = extra.noService;
    this.authRequired = extra.authRequired;
    this.authFailed = extra.authFailed;
    this.needLogin = extra.needLogin;
    this.missingConnection = extra.missingConnection;
    this.connectionId = extra.connectionId;
    this.connectionName = extra.name;
  }
}

export const NO_DB_SERVICE =
  'Database connections are not available on this website: it only hosts the designer, without the ReportTool server program that talks to databases. ' +
  'Use JSON or CSV data here, or run ReportTool on your computer ("npm run dev") to design with database data.';

/** asks the user for the team password (sign-in dialog); true = signed in. Set by the designer store. */
let authHandler: (() => Promise<boolean>) | null = null;
export function setAuthHandler(fn: () => Promise<boolean>) {
  authHandler = fn;
}

async function api<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-reporttool': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new DbError('The ReportTool database service is not running. Start the app with "npm run dev" (or "npm start" for the built version).');
  }
  // The ReportTool server always answers in JSON. A static host (e.g. a Render static site) has no /api at all:
  // it answers 404, or even "200 OK" with an empty body for POST — that must never count as success.
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new DbError(NO_DB_SERVICE, res.status, { noService: true });
  const data = await res.json().catch(() => ({}));
  // team password: sign in, then repeat the request once
  if (res.status === 401 && data.authRequired && !retried && authHandler && (await authHandler())) return api<T>(method, url, body, true);
  if (!res.ok) throw new DbError(data.error || `Request failed (${res.status})`, res.status, data);
  return data as T;
}

export const serverHealth = () =>
  api<{ ok: boolean; providers: string[]; savesConnections?: boolean; auth?: boolean; signedIn?: boolean; public?: boolean }>('GET', './api/health');
export const signIn = (password: string) => api<{ ok: boolean }>('POST', './api/auth/login', { password }, true);
export const signOut = () => api<{ ok: boolean }>('POST', './api/auth/logout', {}, true);
export const listConnections = () => api<DbConnection[]>('GET', './api/connections');
export const saveConnection = (c: DbConnection) => api<DbConnection>('POST', './api/connections', c);
export const deleteConnection = (id: string) => api<{ ok: boolean }>('DELETE', './api/connections/' + encodeURIComponent(id));
export const testConnection = (c: DbConnection) => api<{ ok: boolean; version: string }>('POST', './api/connections/test', { connection: c });
export const loginConnection = (id: string, password: string) => api<{ ok: boolean; version: string; connection: DbConnection }>('POST', `./api/connections/${encodeURIComponent(id)}/login`, { password });
export const getSchema = (connectionId: string) => api<DbSchema>('POST', './api/db/schema', { connectionId });
export const getRoutineParams = (connectionId: string, object: Partial<DbObject>) => api<{ params: DbParamInfo[]; returnType?: string }>('POST', './api/db/params', { connectionId, object });

const pad = (n: number, l = 2) => String(n).padStart(l, '0');
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Evaluate the parameter value expressions of a SQL source (e.g. ?CustomerId) with the report parameter values. */
export function resolveSqlParams(src: SqlSource, ctx: Partial<EvalContext>): { name: string; type: ParamType; value: unknown }[] {
  const full: EvalContext = { row: null, rows: [], params: {}, ...ctx } as EvalContext;
  return (src.params ?? [])
    .filter((p) => p.mode !== 'OUT')
    .map((p) => {
      let v = p.value?.trim() ? evalExpr(p.value, full) : null;
      if (typeof v === 'string' && v.startsWith('#Error')) v = null;
      if (isDate(v)) v = localIso(v);
      return { name: p.name, type: p.type, value: v ?? null };
    });
}

export function executeSql(src: SqlSource, params: { name: string; type: ParamType; value: unknown }[], maxRows: number) {
  return api<DbResult>('POST', './api/db/execute', {
    connectionId: src.connectionId,
    // the name lets the server find the connection when it was created again (new id) after a restart
    connectionName: src.connectionName,
    source: {
      mode: src.mode,
      schema: src.schema,
      name: src.name,
      pkg: src.pkg,
      specific: src.specific,
      returnsTable: src.returnsTable,
      returnType: src.returnType,
      query: src.query,
      params: src.params.map((p) => ({ name: p.name, mode: p.mode, dbType: p.dbType })),
    },
    params,
    maxRows,
  });
}

export function fieldsFromResult(r: DbResult, infer: (rows: Row[]) => FieldDef[]): FieldDef[] {
  const inferred = new Map(infer(r.rows).map((f) => [f.name, f.type]));
  return r.columns.map((c) => ({ name: c.name, type: (c.type ?? inferred.get(c.name) ?? 'string') as FieldType }));
}

/** Find @name / :name parameter markers in a SQL text (ignoring strings, comments, @@vars and ::casts). */
export function detectQueryParams(sql: string): string[] {
  const out: string[] = [];
  const s = sql ?? '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const two = s.slice(i, i + 2);
    if (two === '--') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
      continue;
    }
    if (two === '/*') {
      const j = s.indexOf('*/', i + 2);
      i = j < 0 ? s.length : j + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < s.length && !(s[j] === end && s[j + 1] !== end)) j += s[j] === end ? 2 : 1;
      i = j + 1;
      continue;
    }
    if ((c === '@' || c === ':') && !/[\w:@$]/.test(s[i - 1] ?? '') && s[i + 1] !== c) {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(i + 1));
      if (m) {
        if (!out.some((x) => x.toLowerCase() === m[0].toLowerCase())) out.push(m[0]);
        i += 1 + m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

export function objectLabel(src: SqlSource): string {
  if (src.mode === 'query') return 'Custom SQL query';
  return [src.schema, src.pkg, src.name].filter(Boolean).join('.');
}
