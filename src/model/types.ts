// Core report definition model. All geometry is stored in CSS pixels (96 DPI).

export type BandType =
  | 'reportHeader'
  | 'pageHeader'
  | 'groupHeader'
  | 'detail'
  | 'groupFooter'
  | 'reportFooter'
  | 'pageFooter'
  /** Detail Report (sub-section with its own data source): header, repeating rows, footer */
  | 'drHeader'
  | 'drDetail'
  | 'drFooter';

export type HAlign = 'left' | 'center' | 'right' | 'justify';
export type VAlign = 'top' | 'middle' | 'bottom';
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** Visual style. Every property is optional: undefined means "inherit" (named style -> report base style). */
export interface StyleProps {
  fontFamily?: string;
  fontSize?: number; // points
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  backColor?: string;
  textAlign?: HAlign;
  vAlign?: VAlign;
  padding?: number; // px
  /** Border sides as letters: t r b l. '' = none, 'tlbr' = all */
  borders?: string;
  borderWidth?: number;
  borderColor?: string;
  borderStyle?: LineStyle;
}

export type ResolvedStyle = Required<StyleProps>;

export interface FormatRule {
  id: string;
  condition: string; // expression -> boolean
  style: StyleProps;
  hide?: boolean;
}

export type ElementType =
  | 'text'
  | 'image'
  | 'line'
  | 'shape'
  | 'barcode'
  | 'chart'
  | 'checkbox'
  | 'pageInfo'
  | 'table'
  | 'crosstab';

export type SummaryFunc = 'none' | 'sum' | 'count' | 'avg' | 'min' | 'max' | 'countDistinct' | 'first' | 'last';
export type SummaryRunning = 'none' | 'group' | 'page' | 'report';

interface ElementBase {
  id: string;
  type: ElementType;
  name: string;
  bandId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  styleName?: string;
  style: StyleProps;
  /** Expression; when it evaluates to false the element is not printed. Empty = always visible. */
  visibleExpr?: string;
  formatRules?: FormatRule[];
  /** Expression whose value is added to the preview document map. */
  bookmark?: string;
  locked?: boolean;
}

export interface TextElement extends ElementBase {
  type: 'text';
  /** Static text. Supports {expression} interpolation, e.g. "Total: {Sum([Amount])}" */
  text: string;
  /** When non-empty the element is data-bound and shows the formatted expression value. */
  expression: string;
  format: string;
  summaryFunc: SummaryFunc;
  summaryRunning: SummaryRunning;
  wordWrap: boolean;
  canGrow: boolean;
  canShrink: boolean;
  nullText: string;
}

export type ImageSizing = 'stretch' | 'zoom' | 'cover';
export interface ImageElement extends ElementBase {
  type: 'image';
  src: string; // data url or url
  expression: string; // optional field containing url/base64
  sizing: ImageSizing;
}

export type LineDirection = 'horizontal' | 'vertical' | 'slantDown' | 'slantUp';
export interface LineElement extends ElementBase {
  type: 'line';
  direction: LineDirection;
  lineWidth: number;
  lineStyle: LineStyle;
  lineColor: string;
}

export type ShapeKind = 'rectangle' | 'roundRect' | 'ellipse' | 'triangle' | 'diamond' | 'arrowRight' | 'star';
export interface ShapeElement extends ElementBase {
  type: 'shape';
  shape: ShapeKind;
  fillColor: string;
  lineColor: string;
  lineWidth: number;
  lineStyle: LineStyle;
  cornerRadius: number;
}

export type Symbology = 'code128' | 'code39' | 'ean13' | 'qr';
export interface BarcodeElement extends ElementBase {
  type: 'barcode';
  symbology: Symbology;
  text: string;
  expression: string;
  showText: boolean;
  barColor: string;
}

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut';
export interface ChartElement extends ElementBase {
  type: 'chart';
  chartType: ChartType;
  title: string;
  argument: string; // expression (category)
  value: string; // expression
  series: string; // optional expression splitting into series
  aggregate: SummaryFunc;
  showLegend: boolean;
  showLabels: boolean;
  sortBy: 'none' | 'argument' | 'valueAsc' | 'valueDesc';
  topN: number; // 0 = all
  palette: string; // comma separated colors, empty = default
  valueFormat: string;
}

export interface CheckboxElement extends ElementBase {
  type: 'checkbox';
  expression: string;
  checked: boolean;
  text: string;
}

export type PageInfoKind = 'pageNumber' | 'pageNofM' | 'totalPages' | 'date' | 'time' | 'dateTime' | 'reportName';
export interface PageInfoElement extends ElementBase {
  type: 'pageInfo';
  info: PageInfoKind;
  format: string;
}

export interface TableCell {
  text: string;
  expression: string;
  format: string;
  summaryFunc: SummaryFunc;
  style: StyleProps;
  /** merged cell: spans this many columns / rows to the right / down (the covered cells are not drawn) */
  colSpan?: number;
  rowSpan?: number;
}
export interface TableRow {
  height: number;
  cells: TableCell[];
}
export interface TableElement extends ElementBase {
  type: 'table';
  columns: number[]; // widths
  rows: TableRow[];
  canGrow: boolean;
}

export interface CrosstabElement extends ElementBase {
  type: 'crosstab';
  rowField: string;
  columnField: string;
  valueField: string;
  aggregate: SummaryFunc;
  format: string;
  showRowTotals: boolean;
  showColumnTotals: boolean;
  rowHeaderWidth: number;
  cellWidth: number;
  rowHeight: number;
  headerBackColor: string;
  totalBackColor: string;
  corner: string;
}

export type ReportElement =
  | TextElement
  | ImageElement
  | LineElement
  | ShapeElement
  | BarcodeElement
  | ChartElement
  | CheckboxElement
  | PageInfoElement
  | TableElement
  | CrosstabElement;

export interface Band {
  id: string;
  type: BandType;
  groupId?: string;
  /** drHeader / drDetail / drFooter: the Detail Report this band belongs to */
  detailReportId?: string;
  height: number;
  visible: boolean;
  visibleExpr?: string;
  backColor?: string;
  keepTogether: boolean;
  pageBreakBefore: boolean;
  pageBreakAfter: boolean;
  /** group header: reprint on every page while the group continues */
  repeatEveryPage?: boolean;
  /** page header / footer */
  printOnFirstPage?: boolean;
  printOnLastPage?: boolean;
  /** detail band: alternate (even) row background */
  evenRowColor?: string;
}

export interface GroupDef {
  id: string;
  expression: string;
  sort: 'asc' | 'desc' | 'none';
  keepWithFirstDetail: boolean;
}

export interface SortDef {
  id: string;
  expression: string;
  dir: 'asc' | 'desc';
}

/** master field = child field (a key used to link a detail section to its parent row) */
export interface KeyLink {
  master: string;
  child: string;
}
/**
 * A Detail Report: an extra section with its own data source, header, repeating detail rows and footer.
 *  - parentId null = belongs to the main report, otherwise nested inside another detail report
 *  - printMode 'once': printed one time after all rows of its parent (independent lists)
 *  - printMode 'perRow': printed under every parent row (master–detail), rows matched by `keys` and/or `filter`
 *  Inside a detail report, expressions can use the parent row as [Master.Field].
 */
export interface DetailReportDef {
  id: string;
  name: string;
  dataSourceId: string | null;
  parentId: string | null;
  printMode: 'once' | 'perRow';
  keys: KeyLink[];
  filter: string;
  sort: SortDef[];
}

export type ParamType = 'string' | 'number' | 'date' | 'boolean';
export interface ParameterDef {
  id: string;
  name: string;
  label: string;
  type: ParamType;
  defaultValue: string;
  /** optional comma separated list of allowed values (lookup) */
  values: string;
  visible: boolean;
}

export interface CalcFieldDef {
  id: string;
  name: string;
  expression: string;
}

export interface NamedStyle {
  id: string;
  name: string;
  style: StyleProps;
}

export interface Watermark {
  enabled: boolean;
  text: string;
  fontSize: number;
  color: string;
  opacity: number;
  angle: number;
  image: string;
  imageOpacity: number;
  behind: boolean;
}

export type FieldType = 'string' | 'number' | 'date' | 'boolean';
export interface FieldDef {
  name: string;
  type: FieldType;
}

export type DataSourceKind = 'sample' | 'json' | 'csv' | 'url' | 'sql';

export type SqlMode = 'table' | 'view' | 'procedure' | 'function' | 'query';
export interface SqlParam {
  name: string;
  type: ParamType;
  /** expression evaluated before the query runs, e.g. ?CustomerId, 'USA', Today() */
  value: string;
  mode?: string; // IN / OUT / INOUT
  dbType?: string;
}
/** Database source. Only the connection *name/id* is stored in the report — credentials stay on the server. */
export interface SqlSource {
  connectionId: string;
  connectionName?: string;
  mode: SqlMode;
  schema?: string;
  name?: string;
  /** Oracle package of a packaged procedure / function */
  pkg?: string;
  /** PostgreSQL specific routine name (overloads) */
  specific?: string;
  returnsTable?: boolean;
  returnType?: string;
  query?: string;
  params: SqlParam[];
  maxRows?: number;
}

export interface DataSourceDef {
  id: string;
  name: string;
  kind: DataSourceKind;
  sample?: string;
  content?: string; // json or csv text
  url?: string;
  /** dotted path to the array inside a JSON document, e.g. "data.items" */
  path?: string;
  sql?: SqlSource;
  fields: FieldDef[];
}

export interface PageSettings {
  /** key of PAPER_SIZES or 'Custom' */
  paper: string;
  orientation: 'portrait' | 'landscape';
  /** effective page width (px); >= baseWidth when autoWidth is on */
  width: number;
  height: number;
  /** width chosen by the user (paper size or custom); autoWidth never shrinks below it */
  baseWidth?: number;
  /** grow the page width to fit the widest control / table */
  autoWidth?: boolean;
  /** roll paper: one continuous page whose height fits all content (no page breaks) */
  autoHeight?: boolean;
  margins: { top: number; right: number; bottom: number; left: number };
}

export interface ReportDef {
  version: 1;
  name: string;
  description: string;
  author: string;
  page: PageSettings;
  bands: Band[];
  elements: ReportElement[];
  groups: GroupDef[];
  sort: SortDef[];
  filter: string;
  dataSourceId: string | null;
  detailReports: DetailReportDef[];
  dataSources: DataSourceDef[];
  parameters: ParameterDef[];
  calculatedFields: CalcFieldDef[];
  styles: NamedStyle[];
  baseStyle: ResolvedStyle;
  watermark: Watermark;
  locale: string;
  currency: string;
  /** Google Fonts added by name (not in the built-in list) — loaded when the report opens */
  fonts?: string[];
}

export type Row = Record<string, unknown>;
