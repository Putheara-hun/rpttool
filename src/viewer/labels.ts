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
};
export type LabelKey = keyof typeof DEFAULT_LABELS;

export const labels = reactive({ ...DEFAULT_LABELS });

/** the host's words (unknown keys are ignored, empty values keep the English) */
export function setLabels(v: Record<string, unknown> | undefined) {
  if (!v || typeof v !== 'object') return;
  for (const [k, text] of Object.entries(v)) if (k in DEFAULT_LABELS && typeof text === 'string' && text.trim()) labels[k as LabelKey] = text;
}

/** light / dark, like the host application (its theme variables are defined in viewer.css) */
export function setTheme(theme: unknown) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
}
