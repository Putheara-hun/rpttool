// "Special fields": row numbers, page numbers and dates offered next to the data fields
// (field drop-down of a cell / label, Field List panel).
import type { HAlign, ReportDef } from '../model/types';
import type { FieldChoice } from '../store/designer';

export interface SpecialField extends FieldChoice {
  badge: string;
  desc: string;
}

export function specialFields(r: ReportDef): SpecialField[] {
  const center: HAlign = 'center';
  const list: SpecialField[] = [
    { expr: 'RecordNumber()', name: 'Row No. (1, 2, 3 …)', caption: 'No.', type: 'special', align: center, badge: 'no', desc: 'Counts the rows of the list: 1, 2, 3 … (continues across groups and pages)' },
  ];
  if (r.groups.length) list.push({ expr: 'RowNumber()', name: 'Row No. in group', caption: 'No.', type: 'special', align: center, badge: 'no', desc: 'Starts again at 1 in every group' });
  list.push(
    { expr: 'Page {PageNumber()} of {PageCount()}', text: 'Page {PageNumber()} of {PageCount()}', name: 'Page N of M', type: 'special', badge: 'pg', desc: 'e.g. "Page 2 of 5"' },
    { expr: 'PageNumber()', name: 'Page number', type: 'special', badge: 'pg', desc: 'Current page number' },
    { expr: 'PageCount()', name: 'Total pages', type: 'special', badge: 'pg', desc: 'Number of pages of the report' },
    { expr: 'Today()', name: 'Today’s date', type: 'special', format: 'd', badge: 'dt', desc: 'Date when the report is printed' },
    { expr: 'Now()', name: 'Date & time printed', type: 'special', format: 'g', badge: 'dt', desc: 'Date and time when the report is printed' },
    { expr: 'ReportName()', name: 'Report name', type: 'special', badge: 'abc', desc: 'Name of the report' },
  );
  return list;
}
