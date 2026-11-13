// Report Viewer: report text (HTML / XML-RDL / JSON from the designer's Copy Text, or an RDL from Report Builder)
// -> a report definition with the data and parameter values the host system supplies.
//
// The viewer only DISPLAYS: it never loads data itself. The rows come from the application (its controller runs the
// query with the user's filter); a data source the application does not send is shown empty — a database data source
// of the design is never queried here.
import type { ReportDef, Row } from '../model/types';
import { uid } from '../model/defaults';
import { inferFields } from '../data/dataSource';
import { parseReportText, type SaveFormat } from '../store/designer';

const HINT: Record<string, SaveFormat> = { json: 'rptx', rptx: 'rptx', xml: 'rdl', rdl: 'rdl', rdlc: 'rdl', html: 'html', htm: 'html' };

/** rows for the report's main data source, or rows per data source name */
export type HostData = Row[] | Record<string, Row[]>;

export interface OpenOptions {
  /** title to show instead of the report's own name */
  name?: string;
  /** 'xml' | 'html' | 'json' — recognised from the text when left out */
  format?: string;
  /**
   * The rows to show: a list of rows (= the report's main data source, whatever its name), or rows per data source
   * name. Names the design does not have go to the main data source.
   */
  data?: HostData;
  /** report parameter values by name */
  params?: Record<string, unknown>;
}

/** Parse the text and apply the host's data; parameters the report does not declare are added (hidden). */
export async function prepareReport(text: string, o: OpenOptions = {}): Promise<{ def: ReportDef; warnings: string[] }> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('No report text was given.');
  const hint = o.format ? HINT[o.format.toLowerCase()] : undefined;
  // an RDL edited in Report Builder after the designer saved it: show it as it is now
  let parsed: Awaited<ReturnType<typeof parseReportText>>;
  try {
    parsed = await parseReportText(text, o.name || 'report', hint, 'rdl');
  } catch (e) {
    throw new Error(`This is not a report text — expected the XML (RDL), HTML or JSON copied from the designer (${(e as Error).message})`);
  }
  const { def, warnings } = parsed;
  if (o.name) def.name = o.name;
  const sent = hasData(o.data);
  const provided = new Set(sent ? applyData(def, o.data!) : []);
  displayOnly(def, provided, sent);
  if (o.params) declareParams(def, Object.keys(o.params));
  return { def, warnings };
}

const hasData = (d: HostData | undefined) => !!d && (Array.isArray(d) || Object.keys(d).length > 0);

/**
 * Nothing is loaded by the viewer: data sources the application did not send become empty. Without any data from
 * the application, rows written into the text itself (JSON / CSV sources) are still shown — database and web sources
 * never run.
 */
function displayOnly(def: ReportDef, provided: Set<string>, sent: boolean) {
  for (const ds of def.dataSources) {
    if (provided.has(ds.id)) continue;
    if (sent || ds.kind === 'sql' || ds.kind === 'url') {
      ds.kind = 'json';
      ds.content = '[]';
      delete ds.sql;
      delete ds.url;
      delete ds.path;
    }
  }
}

/** The report's main data source (created when the design has none). */
function mainSource(def: ReportDef) {
  let ds = def.dataSources.find((d) => d.id === def.dataSourceId) ?? def.dataSources[0];
  if (!ds) {
    ds = { id: uid('ds'), name: 'DataSet1', kind: 'json', content: '[]', fields: [] };
    def.dataSources.push(ds);
  }
  def.dataSourceId ||= ds.id;
  return ds;
}

/**
 * Rows from the application replace data sources of the design: a plain list goes to the main data source; rows per
 * name go to the data source of that name (case-insensitive) — a name the design does not have goes to the main one
 * (so "DataSet1" from the application still fills a design whose data source is called "Database1").
 */
export function applyData(def: ReportDef, data: HostData): string[] {
  const ids: string[] = [];
  const entries: [string | null, Row[]][] = Array.isArray(data) ? [[null, data]] : Object.entries(data ?? {});
  for (const [name, rows] of entries) {
    if (!Array.isArray(rows)) throw new Error(`The data for "${name}" must be a list of rows.`);
    const named = name == null ? undefined : def.dataSources.find((d) => d.name.toLowerCase() === name.toLowerCase());
    // a name the design does not have: the main data source, unless it was filled already
    const ds = named ?? (ids.includes(mainSource(def).id) ? null : mainSource(def));
    if (!ds) continue;
    // keep the field types of the design; add columns it does not know yet
    const known = new Set((ds.fields ?? []).map((f) => f.name.toLowerCase()));
    ds.fields = [...(ds.fields ?? []), ...inferFields(rows).filter((f) => !known.has(f.name.toLowerCase()))];
    ds.kind = 'json';
    ds.content = JSON.stringify(rows);
    delete ds.sql;
    delete ds.url;
    delete ds.path;
    ids.push(ds.id);
  }
  return ids;
}

/** Parameters the host sends that the report does not declare (e.g. TITLE, LOGO): hidden text parameters. */
export function declareParams(def: ReportDef, names: string[]) {
  for (const name of names) {
    if (!name || def.parameters.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    def.parameters.push({ id: uid('p'), name, label: name, type: 'string', defaultValue: '', values: '', visible: false });
  }
}

/** Host values keyed by the report's own parameter names (matched case-insensitively). */
export function paramValuesFor(def: ReportDef, params: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const p = def.parameters.find((x) => x.name.toLowerCase() === k.toLowerCase());
    out[p ? p.name : k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }
  return out;
}
