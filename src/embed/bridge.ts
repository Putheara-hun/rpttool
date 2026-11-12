// Embed mode: the designer runs inside an iframe of another system and hands the report back as TEXT.
// The host page talks to it with window.postMessage (see public/embed.js for a ready-made helper):
//
//   host -> designer                                         designer -> host
//   reporttool:init     { formats, format, saveLabel,        reporttool:ready    { version, formats, format }
//                         title, saveUrl, saveHeaders }      reporttool:save     { format, content, mimeType, name, fileName,
//   reporttool:load     { content, format?, name? }                                extraFiles, warnings }   (user clicked Save)
//   reporttool:new      { name? }                            reporttool:changed  { dirty }
//   reporttool:getOutput{ format? }                          reporttool:loaded / output / dataSet / ok  (answers, with requestId)
//   reporttool:setData  { name, rows, fields? }              reporttool:error    { message, requestId? }
//   reporttool:setFormat{ format }                           reporttool:saved    { format, status }        (saveUrl mode)
//   reporttool:saved    { ok, message? }  (host stored it)
//
// Every request may carry a requestId; the answer repeats it.
import { reactive, watch } from 'vue';
import type { FieldDef, Row } from '../model/types';
import { newReport, uid } from '../model/defaults';
import { inferFields } from '../data/dataSource';
import { buildText, invalidateData, loadReport, mutate, notify, parseReportText, state, type SaveFormat } from '../store/designer';

export type OutputFormat = 'json' | 'xml' | 'html';
const ALIAS: Record<string, OutputFormat> = { json: 'json', rptx: 'json', xml: 'xml', rdl: 'xml', html: 'html', htm: 'html' };
const TO_SAVE: Record<OutputFormat, SaveFormat> = { json: 'rptx', xml: 'rdl', html: 'html' };
const EXT: Record<OutputFormat, string> = { json: '.rptx', xml: '.rdl', html: '.html' };
export const FORMAT_LABEL: Record<OutputFormat, string> = { json: 'JSON (design)', xml: 'XML (RDL)', html: 'HTML (report + design)' };

export const embed = reactive({
  active: false,
  formats: ['json', 'xml', 'html'] as OutputFormat[],
  format: 'json' as OutputFormat,
  saveLabel: 'Save',
  title: '',
  /** optional: the designer POSTs the text to this URL of the host system instead of only sending a message */
  saveUrl: '',
  saveHeaders: {} as Record<string, string>,
  saving: false,
});

let hostOrigin = '';
let allowed: string[] = [];
const parsedFormats = (v: unknown): OutputFormat[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((x) => ALIAS[String(x).trim().toLowerCase()])
    .filter((x, i, a): x is OutputFormat => !!x && a.indexOf(x) === i);

function send(type: string, data: Record<string, unknown> = {}) {
  if (window.parent === window) return;
  // plain data only (Vue reactive arrays / objects cannot be copied by postMessage)
  const plain = JSON.parse(JSON.stringify({ type: 'reporttool:' + type, ...data }));
  window.parent.postMessage(plain, hostOrigin || '*');
}

/** Start embed mode when the page was opened with ?embed=1. */
export function initEmbed() {
  const p = new URLSearchParams(location.search);
  const flag = p.get('embed');
  if (flag === null || flag === '0' || flag === 'false') return;
  embed.active = true;
  state.embedded = true;
  const fm = parsedFormats(p.get('formats'));
  if (fm.length) embed.formats = fm;
  const f = ALIAS[(p.get('format') ?? '').toLowerCase()];
  embed.format = f && embed.formats.includes(f) ? f : embed.formats[0];
  embed.saveLabel = p.get('saveLabel') || 'Save';
  embed.title = p.get('title') || '';
  // which pages may talk to the designer: ?origins=https://erp.example.com (comma list), else the embedding page
  allowed = (p.get('origins') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  try {
    hostOrigin = allowed.length === 1 ? allowed[0] : document.referrer ? new URL(document.referrer).origin : '';
  } catch {
    hostOrigin = '';
  }
  if (allowed.length > 1) hostOrigin = '';
  window.addEventListener('message', (e) => void onMessage(e));
  watch(
    () => state.dirty,
    (dirty) => send('changed', { dirty }),
  );
  send('ready', { version: 1, formats: embed.formats, format: embed.format });
}

const baseName = () => (state.report.name || 'report').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'report';

/** The current report as text in a format. */
export async function outputText(format: OutputFormat = embed.format) {
  const r = await buildText(TO_SAVE[format], baseName());
  return {
    format,
    content: r.text,
    mimeType: r.mime,
    name: state.report.name,
    fileName: baseName() + EXT[format],
    extraFiles: r.extra.map((x) => ({ name: x.name, content: x.text })),
    warnings: r.warnings,
  };
}

/** Save button / Ctrl+S in embed mode: hand the text to the host (message, or POST to its saveUrl). */
export async function saveToHost(format: OutputFormat = embed.format) {
  if (embed.saving) return;
  embed.saving = true;
  try {
    const out = await outputText(format);
    if (embed.saveUrl) {
      const res = await fetch(embed.saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': out.mimeType + '; charset=utf-8', ...embed.saveHeaders, 'X-ReportTool-Format': format, 'X-ReportTool-Name': encodeURIComponent(out.name) },
        body: out.content,
      });
      if (!res.ok) throw new Error(`the application answered HTTP ${res.status}`);
      state.dirty = false;
      notify('Saved', 'success');
      send('saved', { format, status: res.status, name: out.name });
    } else {
      send('save', out);
      state.dirty = false;
      notify(`Sent to the application to save (${FORMAT_LABEL[format]})`, 'success');
    }
  } catch (e) {
    const message = (e as Error).message;
    notify('Save failed: ' + message, 'error');
    send('error', { message });
  } finally {
    embed.saving = false;
  }
}

/** Sample / real rows from the host system as a data source (fields for the design and data for the preview). */
function setData(name: string, rows: Row[], fields?: FieldDef[]) {
  if (!name || !Array.isArray(rows)) throw new Error('setData needs a name and an array of rows');
  const wasDirty = state.dirty;
  let id = '';
  mutate((r) => {
    const f = fields?.length ? fields : inferFields(rows);
    let ds = r.dataSources.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!ds) {
      ds = { id: uid('ds'), name, kind: 'json', content: JSON.stringify(rows), fields: f };
      r.dataSources.push(ds);
    } else {
      ds.kind = 'json';
      ds.content = JSON.stringify(rows);
      ds.fields = f;
      delete ds.sql;
      delete ds.url;
    }
    if (!r.dataSourceId) r.dataSourceId = ds.id;
    id = ds.id;
  });
  state.dirty = wasDirty; // data from the host is not an edit of the user
  invalidateData(id);
  return id;
}

async function onMessage(e: MessageEvent) {
  if (window.parent === window || e.source !== window.parent) return;
  if (allowed.length && !allowed.includes(e.origin)) return;
  if (!allowed.length && hostOrigin && e.origin !== hostOrigin) return;
  const m = e.data as Record<string, any>;
  if (!m || typeof m.type !== 'string' || !m.type.startsWith('reporttool:')) return;
  if (!hostOrigin) hostOrigin = e.origin;
  const type = m.type.slice('reporttool:'.length);
  const requestId = m.requestId;
  const reply = (t: string, data: Record<string, unknown> = {}) => send(t, { ...data, requestId });
  try {
    switch (type) {
      case 'init': {
        const fm = parsedFormats(m.formats);
        if (fm.length) embed.formats = fm;
        const f = ALIAS[String(m.format ?? '').toLowerCase()];
        if (f && embed.formats.includes(f)) embed.format = f;
        else if (!embed.formats.includes(embed.format)) embed.format = embed.formats[0];
        if (typeof m.saveLabel === 'string') embed.saveLabel = m.saveLabel;
        if (typeof m.title === 'string') embed.title = m.title;
        if (typeof m.saveUrl === 'string') embed.saveUrl = m.saveUrl;
        if (m.saveHeaders && typeof m.saveHeaders === 'object') embed.saveHeaders = { ...m.saveHeaders };
        reply('ok', { formats: embed.formats, format: embed.format });
        break;
      }
      case 'load': {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const hint = m.format ? TO_SAVE[ALIAS[String(m.format).toLowerCase()]] : undefined;
        const name = String(m.name || 'report');
        const { def, warnings } = await parseReportText(content, name, hint);
        if (m.name) def.name = String(m.name);
        loadReport(def, baseName() + '.rptx');
        reply('loaded', { name: state.report.name, warnings });
        break;
      }
      case 'new': {
        const r = newReport();
        if (m.name) r.name = String(m.name);
        loadReport(r, baseName() + '.rptx');
        reply('loaded', { name: state.report.name, warnings: [] });
        break;
      }
      case 'getOutput': {
        const f = ALIAS[String(m.format ?? embed.format).toLowerCase()] ?? embed.format;
        reply('output', await outputText(f));
        break;
      }
      case 'setData': {
        const id = setData(String(m.name ?? ''), m.rows, m.fields);
        reply('dataSet', { name: m.name, id, rows: m.rows.length });
        break;
      }
      case 'setFormat': {
        const f = ALIAS[String(m.format ?? '').toLowerCase()];
        if (f && embed.formats.includes(f)) embed.format = f;
        reply('ok', { format: embed.format });
        break;
      }
      case 'saved': {
        if (m.ok === false) {
          state.dirty = true;
          notify('The application could not save the report' + (m.message ? ': ' + m.message : ''), 'error');
        } else notify('Saved', 'success');
        break;
      }
      default:
        reply('error', { message: 'Unknown message ' + m.type });
    }
  } catch (err) {
    reply('error', { message: (err as Error).message });
  }
}
