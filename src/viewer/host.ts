// Report Viewer <-> host system (any web application that shows reports), with window.postMessage.
// The viewer runs in an iframe of the host page, or in a tab the host opened (window.open); see public/viewer.js.
//
//   host -> viewer                                              viewer -> host
//   reportviewer:init      { labels?, theme? }                  reportviewer:ready     { version }
//   reportviewer:load      { content, format?, name?,           reportviewer:loaded    { name, warnings }
//                            data?: rows[] | { <source>: rows[] }, reportviewer:rendered  { pages }
//                            params?: { <name>: value } }       reportviewer:refresh   (the user clicked Refresh)
//   reportviewer:setData   { name, rows }                       reportviewer:error     { message }
//   reportviewer:setParams { values, refresh? }                 reportviewer:ok        (answer)
//   reportviewer:refresh   { reloadData? }
//   reportviewer:print     {}
//   reportviewer:export    { format: pdf|xlsx|csv|html|png }
//   labels: the viewer's words by the host viewer's keys (rpt_print, rpt_of, …); theme: 'light' | 'dark';
//   layout: 'page' (one page at a time) | 'scroll' (all pages one after another)
//
// Every request may carry a requestId; its answer (loaded / ok / error) repeats it.
// Only the page that opened the viewer is answered: ?origins=https://erp.example.com (comma list) or, without it,
// the embedding page (document.referrer) / the first page that talks to it.
import { reactive } from 'vue';
import type { Row } from '../model/types';
import type { OpenOptions } from './load';
import { hostLayout, setLabels, setTheme } from './labels';

export type ExportFormat = 'pdf' | 'xlsx' | 'docx' | 'csv' | 'html' | 'png';
export interface ViewerController {
  open(text: string, o: OpenOptions): Promise<{ name: string; warnings: string[] }>;
  setData(name: string | null, rows: Row[]): Promise<void>;
  setParams(values: Record<string, unknown>, refresh: boolean): Promise<void>;
  refresh(reloadData: boolean): Promise<void>;
  print(): Promise<void>;
  exportAs(format: ExportFormat): Promise<void>;
}

export const viewerHost = reactive({ active: false });

let target: Window | null = null;
let targetOrigin = '';
let allowed: string[] = [];
let ctl: ViewerController | null = null;

export function setController(c: ViewerController) {
  ctl = c;
}

export function notifyHost(type: string, data: Record<string, unknown> = {}) {
  if (!target) return;
  // plain data only (reactive objects cannot be copied by postMessage)
  const plain = JSON.parse(JSON.stringify({ type: 'reportviewer:' + type, ...data }));
  // before the host has spoken, only the harmless "ready" may go out without a known origin
  if (!targetOrigin && type !== 'ready') return;
  target.postMessage(plain, targetOrigin || '*');
}

/** Hosted mode when the page was opened with ?embed=1 by another page (iframe parent or window.opener). */
export function initViewerHost(): boolean {
  const p = new URLSearchParams(location.search);
  const flag = p.get('embed');
  if (flag === null || flag === '0' || flag === 'false') return false;
  target = window.parent !== window ? window.parent : (window.opener as Window | null);
  if (!target) return false;
  viewerHost.active = true;
  allowed = (p.get('origins') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  try {
    targetOrigin = allowed.length === 1 ? allowed[0] : allowed.length === 0 && document.referrer ? new URL(document.referrer).origin : '';
  } catch {
    targetOrigin = '';
  }
  window.addEventListener('message', (e) => void onMessage(e));
  notifyHost('ready', { version: 1 });
  return true;
}

const FORMATS: ExportFormat[] = ['pdf', 'xlsx', 'docx', 'csv', 'html', 'png'];

async function onMessage(e: MessageEvent) {
  if (!target || e.source !== target) return;
  if (allowed.length && !allowed.includes(e.origin)) return;
  if (!allowed.length && targetOrigin && e.origin !== targetOrigin) return;
  const m = e.data as Record<string, any>;
  if (!m || typeof m.type !== 'string' || !m.type.startsWith('reportviewer:')) return;
  if (!targetOrigin) targetOrigin = e.origin;
  const requestId = m.requestId;
  const reply = (t: string, data: Record<string, unknown> = {}) => notifyHost(t, { ...data, requestId });
  if (!ctl) return reply('error', { message: 'The viewer is still starting.' });
  try {
    // words, theme and page layout may come with any message (init, load); the application's layout is a default,
    // the user's own choice (toolbar) is not overwritten in their browser
    setLabels(m.labels);
    setTheme(m.theme);
    hostLayout(m.layout);
    switch (m.type.slice('reportviewer:'.length)) {
      case 'init':
        reply('ok');
        break;
      case 'load': {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const r = await ctl.open(content, { name: m.name, format: m.format, data: m.data, params: m.params });
        reply('loaded', r);
        break;
      }
      case 'setData':
        if (!Array.isArray(m.rows)) throw new Error('setData needs a list of rows.');
        await ctl.setData(m.name ? String(m.name) : null, m.rows);
        reply('ok', { rows: m.rows.length });
        break;
      case 'setParams':
        await ctl.setParams(m.values && typeof m.values === 'object' ? m.values : {}, m.refresh !== false);
        reply('ok');
        break;
      case 'refresh':
        await ctl.refresh(!!m.reloadData);
        reply('ok');
        break;
      case 'print':
        await ctl.print();
        reply('ok');
        break;
      case 'export': {
        const f = String(m.format ?? 'pdf').toLowerCase() as ExportFormat;
        if (!FORMATS.includes(f)) throw new Error('Export format must be one of: ' + FORMATS.join(', '));
        await ctl.exportAs(f);
        reply('ok');
        break;
      }
      default:
        reply('error', { message: 'Unknown message ' + m.type });
    }
  } catch (err) {
    reply('error', { message: (err as Error).message });
  }
}
