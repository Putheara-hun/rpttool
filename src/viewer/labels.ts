// Words of the Report Viewer. The keys are the ones the host application's own report viewer uses (rpt_*), so it
// can pass its translations (e.g. Khmer) straight through: ReportViewer.embed(box, { labels: { rpt_print: '…' } }).
import { reactive } from 'vue';

export const DEFAULT_LABELS = {
  rpt_first_page: 'First page',
  rpt_prev_page: 'Previous page',
  rpt_next_page: 'Next page',
  rpt_last_page: 'Last page',
  rpt_page_number: 'Page number',
  rpt_of: 'of',
  rpt_zoom_pct: 'Zoom %',
  rpt_zoom: 'Zoom',
  rpt_export: 'Export',
  rpt_export_excel: 'Excel (.xlsx)',
  rpt_export_pdf: 'PDF',
  rpt_export_html: 'HTML',
  rpt_export_csv: 'CSV',
  rpt_export_png: 'Image (.png)',
  rpt_print: 'Print',
  rpt_find: 'Find in report',
  rpt_find_placeholder: 'Find in report…',
  rpt_hit_of: '{a} of {b}',
  rpt_no_matches: 'No matches',
  rpt_prev_match: 'Previous match',
  rpt_next_match: 'Next match',
  rpt_close: 'Close',
  rpt_refresh: 'Refresh',
  rpt_record: 'record',
  rpt_records: 'records',
  rpt_no_data: 'No report to show.',
  rpt_loading: 'Loading…',
  rpt_waiting: 'Waiting for the report…',
  rpt_data_source: 'Data source',
  rpt_layout_scroll: 'Continuous scroll (all pages one after another)',
  rpt_layout_page: 'One page at a time',
  rpt_copy: 'Copy',
  rpt_copy_value: 'Copy value',
  rpt_copy_row: 'Copy row',
  rpt_copy_page: 'Copy page {n}',
  rpt_copy_all: 'Copy all pages',
  rpt_copied: 'Copied',
};
export type LabelKey = keyof typeof DEFAULT_LABELS;

export const labels = reactive({ ...DEFAULT_LABELS });

/** the host's words (unknown keys are ignored, empty values keep the English) */
export function setLabels(v: Record<string, unknown> | undefined) {
  if (!v || typeof v !== 'object') return;
  for (const [k, text] of Object.entries(v)) if (k in DEFAULT_LABELS && typeof text === 'string' && text.trim()) labels[k as LabelKey] = text;
}

/**
 * How pages are shown: 'page' = one page at a time (scrolling past its end opens the next one),
 * 'scroll' = all pages one after another. The user's choice is remembered in this browser.
 */
export type Layout = 'page' | 'scroll';
const LAYOUT_KEY = 'reportviewer.layout';
function storedLayout(): Layout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'scroll' || v === 'page' ? v : 'page';
  } catch {
    return 'page';
  }
}
export const prefs = reactive({ layout: storedLayout() });
let userChose = (() => {
  try {
    return localStorage.getItem(LAYOUT_KEY) !== null;
  } catch {
    return false;
  }
})();
/** the user's choice (toolbar button): applied and remembered */
export function setLayout(v: unknown) {
  if (v !== 'page' && v !== 'scroll') return;
  prefs.layout = v;
  userChose = true;
  try {
    localStorage.setItem(LAYOUT_KEY, v);
  } catch {
    /* storage blocked: the choice lasts until the page is closed */
  }
}
/** the application's default: used until the user picks a layout themselves */
export function hostLayout(v: unknown) {
  if ((v === 'page' || v === 'scroll') && !userChose) prefs.layout = v;
}

/** light / dark, like the host application (its theme variables are defined in viewer.css) */
export function setTheme(theme: unknown) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
}
