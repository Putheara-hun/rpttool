// Ready-made starting points for New ▾: the parts every report of a system shares, so a new report only needs its
// table. They are filled by the application that shows the report — the parameter names are the ones it sends
// (ReportViewBase: TITLE, TEXT1..TEXT6, CMI_NAME_LOCAL / CMI_NAME_ENG, BR_NAME, USER_NAME, PRINT_DATE and the screen's
// FILTER; the report screen adds LOGO and PRINTED_BY). Their default values only fill the designer's preview.
import type { BandType, ReportDef, ReportElement } from './types';
import { contentWidth, createElement, newReport, uid, type ToolId } from './defaults';

export type TemplateKey = 'company';
export const REPORT_TEMPLATES: Record<TemplateKey, { label: string; desc: string }> = {
  company: { label: 'Company report', desc: 'logo, company name, title, filter line, signatures, printed date and page numbers' },
};

/**
 * Company report:
 *   Report Header  logo (?LOGO) | company name in Khmer and English | report title | the filter line (?FILTER)
 *   Page Header / Detail  empty: add the table there (Table tool, or several fields dragged together)
 *   Report Footer  three signature lines from the header lines of Report settings (?TEXT1..?TEXT3), each hidden
 *                  when its text is empty
 *   Page Footer    "Printed <date> by <user>" | Page N of M
 */
export function companyReport(): ReportDef {
  const r = newReport();
  r.name = 'New Report';
  const cw = Math.floor(contentWidth(r));
  const band = (t: BandType) => r.bands.find((b) => b.type === t)!;
  const add = (tool: ToolId, bandType: BandType, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => {
    const el = createElement(tool, band(bandType).id, x, y, r.elements, { width: w, height: h, ...extra } as Partial<ReportElement>);
    r.elements.push(el);
    return el;
  };
  const param = (name: string, defaultValue = '') =>
    r.parameters.push({ id: uid('p'), name, label: name, type: 'string', defaultValue, values: '', visible: false });
  param('LOGO');
  param('CMI_NAME_LOCAL', 'ឈ្មោះក្រុមហ៊ុន');
  param('CMI_NAME_ENG', 'Company Name');
  param('TITLE', 'Report Title');
  param('FILTER', 'From 01-Nov-2026 To 30-Nov-2026');
  param('TEXT1', 'Prepared by');
  param('TEXT2', 'Checked by');
  param('TEXT3', 'Approved by');
  param('PRINT_DATE', '20-Nov-2026 09:00');
  param('PRINTED_BY', 'User name');

  // ---- Report Header: logo, company, title, filter
  band('reportHeader').height = 104;
  add('image', 'reportHeader', 0, 0, 90, 72, { expression: '?LOGO', sizing: 'zoom' });
  add('field', 'reportHeader', 100, 0, cw - 200, 24, { expression: '?CMI_NAME_LOCAL', style: { textAlign: 'center', bold: true, fontSize: 13, fontFamily: 'Khmer OS Battambang' } });
  add('field', 'reportHeader', 100, 24, cw - 200, 20, { expression: '?CMI_NAME_ENG', style: { textAlign: 'center', bold: true, fontSize: 11 } });
  add('field', 'reportHeader', 0, 50, cw, 28, { expression: '?TITLE', style: { textAlign: 'center', bold: true, fontSize: 16 } });
  add('field', 'reportHeader', 0, 80, cw, 20, { expression: '?FILTER', style: { textAlign: 'center', fontSize: 9, color: '#4b5563' } });

  // ---- the table goes into the Page Header / Detail
  band('pageHeader').height = 26;
  band('detail').height = 26;

  // ---- Report Footer: signatures (the header lines of Report settings), a line above each name
  band('reportFooter').height = 90;
  const third = Math.floor(cw / 3);
  ['TEXT1', 'TEXT2', 'TEXT3'].forEach((n, i) =>
    add('field', 'reportFooter', i * third + 16, 56, third - 32, 24, {
      expression: '?' + n,
      visibleExpr: `Not IsNullOrEmpty(?${n})`,
      style: { textAlign: 'center', borders: 't', borderColor: '#111827', padding: 4 },
    }),
  );

  // ---- Page Footer: printed date / user, page numbers
  band('pageFooter').height = 24;
  add('text', 'pageFooter', 0, 2, Math.floor(cw / 2), 18, { text: 'Printed {?PRINT_DATE} by {?PRINTED_BY}', style: { fontSize: 8, color: '#6b7280' } });
  add('pageNofM', 'pageFooter', cw - 160, 2, 160, 18, { style: { textAlign: 'right', fontSize: 8, color: '#6b7280' } });
  return r;
}

export function reportFromTemplate(key: TemplateKey): ReportDef {
  switch (key) {
    case 'company':
      return companyReport();
  }
}
