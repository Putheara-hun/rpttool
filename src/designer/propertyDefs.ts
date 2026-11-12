// Property grid descriptors for report, bands, elements and table cells.
import type { Band, ReportElement } from '../model/types';
import { FONT_FAMILIES } from '../model/defaults';

export type EditorKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'color'
  | 'bool'
  | 'select'
  | 'font'
  | 'expression'
  | 'format'
  | 'borders'
  | 'image'
  | 'styleName'
  | 'formatRules'
  | 'columns'
  | 'dataSource'
  | 'paper'
  | 'mm'
  | 'detailReport';

export interface PropDef {
  path: string;
  label: string;
  cat: string;
  editor: EditorKind;
  options?: { value: string | number; label: string }[];
  min?: number;
  step?: number;
  /** style.* properties may inherit from the named / base style */
  inherit?: boolean;
  help?: string;
}

const opts = (...v: (string | [string, string])[]) => v.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x }));

export const SUMMARY_OPTS = opts(['none', '(none)'], ['sum', 'Sum'], ['count', 'Count'], ['avg', 'Average'], ['min', 'Min'], ['max', 'Max'], ['countDistinct', 'Distinct Count'], ['first', 'First'], ['last', 'Last']);

const STYLE_PROPS: PropDef[] = [
  { path: 'styleName', label: 'Style', cat: 'Appearance', editor: 'styleName' },
  { path: 'style.fontFamily', label: 'Font', cat: 'Appearance', editor: 'font', inherit: true },
  { path: 'style.fontSize', label: 'Font Size (pt)', cat: 'Appearance', editor: 'number', min: 4, step: 0.5, inherit: true },
  { path: 'style.bold', label: 'Bold', cat: 'Appearance', editor: 'bool', inherit: true },
  { path: 'style.italic', label: 'Italic', cat: 'Appearance', editor: 'bool', inherit: true },
  { path: 'style.underline', label: 'Underline', cat: 'Appearance', editor: 'bool', inherit: true },
  { path: 'style.strike', label: 'Strikeout', cat: 'Appearance', editor: 'bool', inherit: true },
  { path: 'style.color', label: 'Fore Color', cat: 'Appearance', editor: 'color', inherit: true },
  { path: 'style.backColor', label: 'Back Color', cat: 'Appearance', editor: 'color', inherit: true },
  { path: 'style.textAlign', label: 'Text Alignment', cat: 'Appearance', editor: 'select', options: opts('left', 'center', 'right', 'justify'), inherit: true },
  { path: 'style.vAlign', label: 'Vertical Alignment', cat: 'Appearance', editor: 'select', options: opts('top', 'middle', 'bottom'), inherit: true },
  { path: 'style.padding', label: 'Padding', cat: 'Appearance', editor: 'number', min: 0, inherit: true },
  { path: 'style.borders', label: 'Borders', cat: 'Borders', editor: 'borders', inherit: true },
  { path: 'style.borderWidth', label: 'Border Width', cat: 'Borders', editor: 'number', min: 0, step: 0.5, inherit: true },
  { path: 'style.borderColor', label: 'Border Color', cat: 'Borders', editor: 'color', inherit: true },
  { path: 'style.borderStyle', label: 'Border Style', cat: 'Borders', editor: 'select', options: opts('solid', 'dashed', 'dotted'), inherit: true },
];

const COMMON_TOP: PropDef[] = [
  { path: 'name', label: 'Name', cat: 'Design', editor: 'text' },
  { path: 'locked', label: 'Locked', cat: 'Design', editor: 'bool' },
];
const LAYOUT: PropDef[] = [
  { path: 'x', label: 'Left', cat: 'Layout', editor: 'number' },
  { path: 'y', label: 'Top', cat: 'Layout', editor: 'number', min: 0 },
  { path: 'width', label: 'Width', cat: 'Layout', editor: 'number', min: 2 },
  { path: 'height', label: 'Height', cat: 'Layout', editor: 'number', min: 2 },
];
const BEHAVIOR: PropDef[] = [
  { path: 'visibleExpr', label: 'Visible When', cat: 'Behavior', editor: 'expression', help: 'Expression; the element prints only when it is true. Empty = always.' },
  { path: 'formatRules', label: 'Format Rules', cat: 'Behavior', editor: 'formatRules' },
  { path: 'bookmark', label: 'Bookmark', cat: 'Behavior', editor: 'expression', help: 'Adds an entry to the preview document map.' },
];

const TYPE_PROPS: Record<ReportElement['type'], PropDef[]> = {
  text: [
    { path: 'text', label: 'Text', cat: 'Data', editor: 'textarea', help: 'Static text. Embed expressions with braces: Total: {Sum([Amount])}' },
    { path: 'expression', label: 'Expression', cat: 'Data', editor: 'expression', help: 'Bind to data, e.g. [ProductName] or [Qty] * [Price]' },
    { path: 'format', label: 'Format String', cat: 'Data', editor: 'format' },
    { path: 'summaryFunc', label: 'Summary', cat: 'Data', editor: 'select', options: SUMMARY_OPTS },
    {
      path: 'summaryRunning',
      label: 'Summary Running',
      cat: 'Data',
      editor: 'select',
      options: opts(['none', '(band scope)'], ['group', 'Group (running)'], ['page', 'Page (running)'], ['report', 'Report (running)']),
    },
    { path: 'nullText', label: 'Null Text', cat: 'Data', editor: 'text' },
    { path: 'wordWrap', label: 'Word Wrap', cat: 'Behavior', editor: 'bool' },
    { path: 'canGrow', label: 'Can Grow', cat: 'Behavior', editor: 'bool' },
    { path: 'canShrink', label: 'Can Shrink', cat: 'Behavior', editor: 'bool' },
  ],
  image: [
    { path: 'src', label: 'Image', cat: 'Data', editor: 'image' },
    { path: 'expression', label: 'Image Expression', cat: 'Data', editor: 'expression', help: 'Field holding a URL or data: URL' },
    { path: 'sizing', label: 'Sizing', cat: 'Behavior', editor: 'select', options: opts(['zoom', 'Zoom (fit)'], ['stretch', 'Stretch'], ['cover', 'Cover (crop)']) },
  ],
  line: [
    { path: 'direction', label: 'Direction', cat: 'Appearance', editor: 'select', options: opts('horizontal', 'vertical', ['slantDown', 'Slant \\'], ['slantUp', 'Slant /']) },
    { path: 'lineColor', label: 'Line Color', cat: 'Appearance', editor: 'color' },
    { path: 'lineWidth', label: 'Line Width', cat: 'Appearance', editor: 'number', min: 0, step: 0.5 },
    { path: 'lineStyle', label: 'Line Style', cat: 'Appearance', editor: 'select', options: opts('solid', 'dashed', 'dotted') },
  ],
  shape: [
    {
      path: 'shape',
      label: 'Shape',
      cat: 'Appearance',
      editor: 'select',
      options: opts(['rectangle', 'Rectangle'], ['roundRect', 'Rounded Rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['arrowRight', 'Arrow'], ['star', 'Star']),
    },
    { path: 'fillColor', label: 'Fill Color', cat: 'Appearance', editor: 'color' },
    { path: 'lineColor', label: 'Line Color', cat: 'Appearance', editor: 'color' },
    { path: 'lineWidth', label: 'Line Width', cat: 'Appearance', editor: 'number', min: 0, step: 0.5 },
    { path: 'lineStyle', label: 'Line Style', cat: 'Appearance', editor: 'select', options: opts('solid', 'dashed', 'dotted') },
    { path: 'cornerRadius', label: 'Corner Radius', cat: 'Appearance', editor: 'number', min: 0 },
  ],
  barcode: [
    { path: 'symbology', label: 'Symbology', cat: 'Data', editor: 'select', options: opts(['code128', 'Code 128'], ['code39', 'Code 39'], ['ean13', 'EAN-13'], ['qr', 'QR Code']) },
    { path: 'text', label: 'Text', cat: 'Data', editor: 'text' },
    { path: 'expression', label: 'Expression', cat: 'Data', editor: 'expression' },
    { path: 'showText', label: 'Show Text', cat: 'Appearance', editor: 'bool' },
    { path: 'barColor', label: 'Bar Color', cat: 'Appearance', editor: 'color' },
  ],
  chart: [
    { path: 'chartType', label: 'Chart Type', cat: 'Chart', editor: 'select', options: opts('column', 'bar', 'line', 'area', 'pie', 'doughnut') },
    { path: 'title', label: 'Title', cat: 'Chart', editor: 'text' },
    { path: 'argument', label: 'Argument (X)', cat: 'Data', editor: 'expression' },
    { path: 'value', label: 'Value (Y)', cat: 'Data', editor: 'expression' },
    { path: 'aggregate', label: 'Aggregate', cat: 'Data', editor: 'select', options: SUMMARY_OPTS.filter((o) => o.value !== 'none' && o.value !== 'first' && o.value !== 'last') },
    { path: 'series', label: 'Series Field', cat: 'Data', editor: 'expression', help: 'Optional: splits values into several series' },
    { path: 'sortBy', label: 'Sort', cat: 'Data', editor: 'select', options: opts(['none', '(data order)'], ['argument', 'By argument'], ['valueAsc', 'Value ascending'], ['valueDesc', 'Value descending']) },
    { path: 'topN', label: 'Top N (0 = all)', cat: 'Data', editor: 'number', min: 0 },
    { path: 'showLegend', label: 'Show Legend', cat: 'Chart', editor: 'bool' },
    { path: 'showLabels', label: 'Show Labels', cat: 'Chart', editor: 'bool' },
    { path: 'valueFormat', label: 'Value Format', cat: 'Chart', editor: 'format' },
    { path: 'palette', label: 'Palette (colors)', cat: 'Chart', editor: 'text', help: 'Comma separated colors, empty = default' },
  ],
  checkbox: [
    { path: 'text', label: 'Text', cat: 'Data', editor: 'text' },
    { path: 'expression', label: 'Checked Expression', cat: 'Data', editor: 'expression' },
    { path: 'checked', label: 'Checked', cat: 'Data', editor: 'bool' },
  ],
  pageInfo: [
    {
      path: 'info',
      label: 'Page Information',
      cat: 'Data',
      editor: 'select',
      options: opts(['pageNumber', 'Page Number'], ['pageNofM', 'Page N of M'], ['totalPages', 'Total Pages'], ['date', 'Current Date'], ['time', 'Current Time'], ['dateTime', 'Date and Time'], ['reportName', 'Report Name']),
    },
    { path: 'format', label: 'Format', cat: 'Data', editor: 'format', help: 'e.g. "Page {0} of {1}" or a date format' },
  ],
  table: [
    { path: 'columns', label: 'Column Widths', cat: 'Layout', editor: 'columns' },
    { path: 'canGrow', label: 'Rows Can Grow', cat: 'Behavior', editor: 'bool' },
  ],
  crosstab: [
    { path: 'rowField', label: 'Row Field', cat: 'Data', editor: 'expression' },
    { path: 'columnField', label: 'Column Field', cat: 'Data', editor: 'expression' },
    { path: 'valueField', label: 'Data Field', cat: 'Data', editor: 'expression' },
    { path: 'aggregate', label: 'Summary', cat: 'Data', editor: 'select', options: SUMMARY_OPTS.filter((o) => o.value !== 'none') },
    { path: 'format', label: 'Format', cat: 'Data', editor: 'format' },
    { path: 'corner', label: 'Corner Text', cat: 'Data', editor: 'text' },
    { path: 'showRowTotals', label: 'Row Totals', cat: 'Behavior', editor: 'bool' },
    { path: 'showColumnTotals', label: 'Column Totals', cat: 'Behavior', editor: 'bool' },
    { path: 'rowHeaderWidth', label: 'Row Header Width', cat: 'Layout', editor: 'number', min: 10 },
    { path: 'cellWidth', label: 'Cell Width', cat: 'Layout', editor: 'number', min: 10 },
    { path: 'rowHeight', label: 'Row Height', cat: 'Layout', editor: 'number', min: 8 },
    { path: 'headerBackColor', label: 'Header Back Color', cat: 'Appearance', editor: 'color' },
    { path: 'totalBackColor', label: 'Total Back Color', cat: 'Appearance', editor: 'color' },
  ],
};

const NO_TEXT_STYLE = new Set(['line', 'shape']);

export function elementProps(el: ReportElement): PropDef[] {
  const style = NO_TEXT_STYLE.has(el.type) ? [] : STYLE_PROPS;
  return [...COMMON_TOP, ...TYPE_PROPS[el.type], ...LAYOUT, ...style, ...BEHAVIOR];
}

export const CELL_PROPS: PropDef[] = [
  { path: 'text', label: 'Text', cat: 'Cell', editor: 'textarea' },
  { path: 'expression', label: 'Expression', cat: 'Cell', editor: 'expression' },
  { path: 'format', label: 'Format String', cat: 'Cell', editor: 'format' },
  { path: 'summaryFunc', label: 'Summary', cat: 'Cell', editor: 'select', options: SUMMARY_OPTS },
  ...STYLE_PROPS.filter((p) => p.path !== 'styleName').map((p) => ({ ...p, cat: 'Cell ' + p.cat })),
];

export function bandProps(b: Band): PropDef[] {
  const out: PropDef[] = [
    { path: 'height', label: 'Height', cat: 'Layout', editor: 'number', min: 0 },
    { path: 'visible', label: 'Visible', cat: 'Behavior', editor: 'bool' },
    { path: 'visibleExpr', label: 'Visible When', cat: 'Behavior', editor: 'expression' },
    { path: 'backColor', label: 'Back Color', cat: 'Appearance', editor: 'color' },
  ];
  if (b.type !== 'pageHeader' && b.type !== 'pageFooter') {
    out.push(
      { path: 'keepTogether', label: 'Keep Together', cat: 'Behavior', editor: 'bool' },
      { path: 'pageBreakBefore', label: 'Page Break Before', cat: 'Behavior', editor: 'bool' },
      { path: 'pageBreakAfter', label: 'Page Break After', cat: 'Behavior', editor: 'bool' },
    );
  }
  if (b.type === 'detail' || b.type === 'drDetail') out.push({ path: 'evenRowColor', label: 'Even Row Color', cat: 'Appearance', editor: 'color' });
  if (b.type === 'drHeader') out.push({ path: 'repeatEveryPage', label: 'Repeat Every Page', cat: 'Behavior', editor: 'bool' });
  if (b.detailReportId) {
    out.unshift(
      { path: 'dr.name', label: 'Section Name', cat: 'Detail Report', editor: 'text' },
      { path: 'dr.dataSourceId', label: 'Data Source', cat: 'Detail Report', editor: 'dataSource', help: 'Each section reads its own data source.' },
      {
        path: 'dr.printMode',
        label: 'Print',
        cat: 'Detail Report',
        editor: 'select',
        options: opts(['once', 'Once (after the parent rows)'], ['perRow', 'For every parent row']),
      },
      { path: 'dr.filter', label: 'Filter', cat: 'Detail Report', editor: 'expression', help: 'Any condition. [Master.Field] = parent row, ?Param = report parameter.' },
      { path: 'dr.settings', label: 'Link, Sort, Bands', cat: 'Detail Report', editor: 'detailReport' },
    );
  }
  if (b.type === 'groupHeader') {
    out.push(
      { path: 'repeatEveryPage', label: 'Repeat Every Page', cat: 'Behavior', editor: 'bool' },
      { path: 'group.expression', label: 'Group Field', cat: 'Group', editor: 'expression' },
      { path: 'group.sort', label: 'Group Sort', cat: 'Group', editor: 'select', options: opts(['asc', 'Ascending'], ['desc', 'Descending'], ['none', 'None']) },
      { path: 'group.keepWithFirstDetail', label: 'Keep With First Detail', cat: 'Group', editor: 'bool' },
    );
  }
  if (b.type === 'pageHeader' || b.type === 'pageFooter') {
    out.push(
      { path: 'printOnFirstPage', label: 'Print On First Page', cat: 'Behavior', editor: 'bool' },
      { path: 'printOnLastPage', label: 'Print On Last Page', cat: 'Behavior', editor: 'bool' },
    );
  }
  return out;
}

export const REPORT_PROPS: PropDef[] = [
  { path: 'name', label: 'Report Name', cat: 'Report', editor: 'text' },
  { path: 'description', label: 'Description', cat: 'Report', editor: 'textarea' },
  { path: 'author', label: 'Author', cat: 'Report', editor: 'text' },
  { path: 'page.paper', label: 'Paper Size', cat: 'Page', editor: 'paper' },
  { path: 'page.orientation', label: 'Orientation', cat: 'Page', editor: 'select', options: opts(['portrait', 'Portrait'], ['landscape', 'Landscape']) },
  { path: 'page.baseWidth', label: 'Paper Width (mm)', cat: 'Page', editor: 'mm', help: 'Changing the width or height switches the paper size to Custom.' },
  { path: 'page.height', label: 'Paper Height (mm)', cat: 'Page', editor: 'mm' },
  { path: 'page.margins.top', label: 'Margin Top (mm)', cat: 'Page', editor: 'mm' },
  { path: 'page.margins.bottom', label: 'Margin Bottom (mm)', cat: 'Page', editor: 'mm' },
  { path: 'page.margins.left', label: 'Margin Left (mm)', cat: 'Page', editor: 'mm' },
  { path: 'page.margins.right', label: 'Margin Right (mm)', cat: 'Page', editor: 'mm' },
  { path: 'page.autoWidth', label: 'Auto Width', cat: 'Page', editor: 'bool', help: 'The page grows wider when a control or table extends past the right margin.' },
  { path: 'page.autoHeight', label: 'Auto Height (roll)', cat: 'Page', editor: 'bool', help: 'Roll paper: the report prints as one continuous page whose height fits all the content.' },
  { path: 'dataSourceId', label: 'Data Source', cat: 'Data', editor: 'dataSource' },
  { path: 'filter', label: 'Filter', cat: 'Data', editor: 'expression', help: 'Only rows where the expression is true are printed' },
  { path: 'locale', label: 'Locale', cat: 'Formatting', editor: 'select', options: opts('en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'ja-JP', 'zh-CN', 'km-KH', 'th-TH', 'vi-VN', 'pt-BR', 'ru-RU', 'ko-KR') },
  { path: 'currency', label: 'Currency', cat: 'Formatting', editor: 'select', options: opts('USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KHR', 'THB', 'VND', 'BRL', 'RUB', 'KRW', 'INR', 'AUD', 'CAD') },
  { path: 'baseStyle.fontFamily', label: 'Default Font', cat: 'Default Style', editor: 'font' },
  { path: 'baseStyle.fontSize', label: 'Default Font Size', cat: 'Default Style', editor: 'number', min: 4, step: 0.5 },
  { path: 'baseStyle.color', label: 'Default Fore Color', cat: 'Default Style', editor: 'color' },
  { path: 'baseStyle.padding', label: 'Default Padding', cat: 'Default Style', editor: 'number', min: 0 },
];

export const FONT_OPTIONS = FONT_FAMILIES.map((f) => ({ value: f, label: f }));
