// Report Viewer: report text (HTML / XML-RDL / JSON from the designer's Copy Text, or an RDL from Report Builder)
// -> a report definition with the data and parameter values the host system supplies.
import type { ReportDef, Row } from '../model/types';
import { uid } from '../model/defaults';
import { inferFields } from '../data/dataSource';
import { parseReportText, type SaveFormat } from '../store/designer';

const HINT: Record<string, SaveFormat> = { json: 'rptx', rptx: 'rptx', xml: 'rdl', rdl: 'rdl', rdlc: 'rdl', html: 'html', htm: 'html' };

export interface OpenOptions {
  /** title to show instead of the report's own name */
  name?: string;
  /** 'xml' | 'html' | 'json' — recognised from the text when left out */
  format?: string;
  /** rows per data source name: they replace that data source (also a database one) */
  data?: Record<string, Row[]>;
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
  if (o.data) applyData(def, o.data);
  if (o.params) declareParams(def, Object.keys(o.params));
  return { def, warnings };
}

/** Rows from the host system become the data source with that name (case-insensitive), or a new one. */
export function applyData(def: ReportDef, data: Record<string, Row[]>): string[] {
  const ids: string[] = [];
  for (const [name, rows] of Object.entries(data ?? {})) {
    if (!Array.isArray(rows)) throw new Error(`The data for "${name}" must be a list of rows.`);
    let ds = def.dataSources.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!ds) {
      ds = { id: uid('ds'), name, kind: 'json', content: '', fields: [] };
      def.dataSources.push(ds);
    }
    // keep the field types of the design; add columns it does not know yet
    const known = new Set((ds.fields ?? []).map((f) => f.name.toLowerCase()));
    ds.fields = [...(ds.fields ?? []), ...inferFields(rows).filter((f) => !known.has(f.name.toLowerCase()))];
    ds.kind = 'json';
    ds.content = JSON.stringify(rows);
    delete ds.sql;
    delete ds.url;
    delete ds.path;
    if (!def.dataSourceId) def.dataSourceId = ds.id;
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
