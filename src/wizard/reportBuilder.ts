// Programmatic report builder used by the Report Wizard.
import { deepClone } from '../model/clone';
import type { Band, BandType, ReportDef, ReportElement, StyleProps, SummaryFunc } from '../model/types';
import { applyOrientation, applyPaper, contentWidth, createElement, newBand, newReport, uid, type ToolId } from '../model/defaults';
import { SAMPLE_SETS } from '../data/sampleData';
import { inferFields } from '../data/dataSource';

export class ReportBuilder {
  r: ReportDef;
  constructor(name: string, paper = 'A4', landscape = false) {
    this.r = newReport();
    this.r.name = name;
    this.r.bands = [];
    applyPaper(this.r.page, paper);
    if (landscape) applyOrientation(this.r.page, 'landscape');
  }
  get cw() {
    return Math.floor(contentWidth(this.r));
  }
  useSample(sample: string) {
    const set = SAMPLE_SETS[sample];
    const id = uid('ds');
    this.r.dataSources.push({ id, name: set.label.split(' (')[0], kind: 'sample', sample, fields: inferFields(set.load()) });
    this.r.dataSourceId = id;
    return id;
  }
  band(type: BandType, height: number, props: Partial<Band> = {}, groupId?: string): Band {
    const b = { ...newBand(type, groupId, height), ...props };
    this.r.bands.push(b);
    return b;
  }
  group(expression: string, headerH: number, footerH: number | null, sort: 'asc' | 'desc' | 'none' = 'asc', headerProps: Partial<Band> = {}) {
    const id = uid('g');
    this.r.groups.push({ id, expression, sort, keepWithFirstDetail: true });
    const header = this.band('groupHeader', headerH, headerProps, id);
    const footer = footerH !== null ? this.band('groupFooter', footerH, {}, id) : null;
    return { header, footer };
  }
  add<T extends ReportElement = ReportElement>(tool: ToolId, band: Band, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): T {
    const el = createElement(tool, band.id, x, y, this.r.elements, { width: w, height: h, ...extra } as Partial<ReportElement>);
    this.r.elements.push(el);
    return el as T;
  }
  text(band: Band, x: number, y: number, w: number, h: number, text: string, style: StyleProps = {}, extra: Record<string, unknown> = {}) {
    return this.add('text', band, x, y, w, h, { text, style, canGrow: false, ...extra });
  }
  field(band: Band, x: number, y: number, w: number, h: number, expression: string, style: StyleProps = {}, extra: Record<string, unknown> = {}) {
    return this.add('field', band, x, y, w, h, { expression, style, canGrow: false, ...extra });
  }
  line(band: Band, x: number, y: number, w: number, color = '#94a3b8', width = 1) {
    return this.add('hline', band, x, y, w, 4, { lineColor: color, lineWidth: width });
  }
  pageFooter(withDate = true) {
    const pf = this.band('pageFooter', 30);
    this.line(pf, 0, 0, this.cw, '#cbd5e1');
    if (withDate) this.add('dateInfo', pf, 0, 8, Math.min(220, this.cw / 2), 18, { format: 'D', style: { fontSize: 8, color: '#64748b' } });
    this.add('pageNofM', pf, Math.max(0, this.cw - 160), 8, Math.min(160, this.cw), 18, { style: { fontSize: 8, color: '#64748b', textAlign: 'right' } });
    return pf;
  }
}

export interface WizardOptions {
  title: string;
  sample?: string;
  dataSource?: { id: string; name: string; kind: any; fields: { name: string; type: string }[]; [k: string]: any };
  fields: { name: string; type: string }[];
  groups: string[];
  summaries: Record<string, SummaryFunc[]>;
  paper: string;
  landscape: boolean;
  theme: 'blue' | 'gray' | 'green' | 'orange';
  zebra: boolean;
  chart: boolean;
}

const THEMES = {
  blue: { main: '#1e3a8a', soft: '#dbeafe', zebra: '#f1f5f9' },
  gray: { main: '#374151', soft: '#e5e7eb', zebra: '#f9fafb' },
  green: { main: '#166534', soft: '#dcfce7', zebra: '#f0fdf4' },
  orange: { main: '#9a3412', soft: '#ffedd5', zebra: '#fff7ed' },
};

export function buildWizardReport(o: WizardOptions): ReportDef {
  const b = new ReportBuilder(o.title || 'Report', o.paper || 'A4', o.landscape);
  if (o.sample) b.useSample(o.sample);
  if (o.dataSource) {
    b.r.dataSources.push(deepClone(o.dataSource) as any);
    b.r.dataSourceId = o.dataSource.id;
  }
  const th = THEMES[o.theme];
  const cw = b.cw;
  const rh = b.band('reportHeader', 50);
  b.text(rh, 0, 0, cw, 32, o.title || 'Report', { fontSize: 18, bold: true, color: th.main });
  b.line(rh, 0, 38, cw, th.main, 2);
  const fields = o.fields.filter((f) => !o.groups.includes(f.name));
  const n = Math.max(1, fields.length);
  const base = Math.floor(cw / n);
  const ph = b.band('pageHeader', 24);
  const groups = o.groups.map((gname, i) => {
    const g = b.group(`[${gname}]`, 28, 26, 'asc', { repeatEveryPage: i === o.groups.length - 1 });
    b.field(g.header, i * 16, 4, Math.min(400, cw - i * 16), 22, `[${gname}]`, { bold: true, fontSize: 11 - i, color: th.main }, { bookmark: `[${gname}]` });
    return g;
  });
  const det = b.band('detail', 20, o.zebra ? { evenRowColor: th.zebra } : {});
  const numeric = (t: string) => t === 'number';
  let x = 0;
  const colX: Record<string, [number, number]> = {};
  fields.forEach((f, i) => {
    const w = i === fields.length - 1 ? cw - x : base;
    const st: StyleProps = numeric(f.type) ? { textAlign: 'right' } : {};
    b.text(ph, x, 0, w, 24, f.name.replace(/([a-z])([A-Z])/g, '$1 $2'), { ...st, bold: true, color: '#ffffff', backColor: th.main, vAlign: 'middle', padding: 4, fontSize: 9 });
    b.field(det, x, 0, w, 20, `[${f.name}]`, { ...st, padding: 4, fontSize: 9, vAlign: 'middle' }, { format: f.type === 'date' ? 'd' : numeric(f.type) && /price|amount|total|salary|cost|freight/i.test(f.name) ? 'n2' : '' });
    colX[f.name] = [x, w];
    x += w;
  });
  const summaryRow = (band: Band, label: string) => {
    const used = Object.entries(o.summaries).filter(([name, funcs]) => colX[name] && funcs.length);
    if (!used.length) return;
    // caption goes left of the first summarized column, or on its own line when there is no room
    const firstX = Math.min(...used.map(([name]) => colX[name][0]));
    const ownLine = firstX < 120;
    const top = ownLine ? 21 : 3;
    for (const [name, funcs] of used) {
      const pos = colX[name];
      funcs.forEach((fn, k) => {
        b.field(band, pos[0], top + k * 18, pos[1], 18, `[${name}]`, { textAlign: 'right', bold: true, fontSize: 9, padding: 4, borders: k === 0 ? 't' : '', borderColor: th.main }, {
          summaryFunc: fn,
          format: fn === 'count' ? 'n0' : 'n2',
          text: '',
        });
      });
      band.height = Math.max(band.height, top + 3 + funcs.length * 18);
    }
    const lbl = used[0][1].map((f) => f[0].toUpperCase() + f.slice(1)).join(' / ');
    b.text(band, 0, 3, ownLine ? cw : firstX - 4, 18, `${label} (${lbl})`, { bold: true, fontSize: 9, color: th.main });
  };
  groups.forEach((g, i) => summaryRow(g.footer!, `{[${o.groups[i]}]} total`));
  const rf = b.band('reportFooter', 30);
  summaryRow(rf, 'Grand total');
  if (o.chart && o.groups.length) {
    const num = fields.find((f) => numeric(f.type));
    if (num) {
      const y = rf.height + 10;
      b.add('chart', rf, 0, y, cw, 220, { chartType: 'column', title: `${num.name} by ${o.groups[0]}`, argument: `[${o.groups[0]}]`, value: `[${num.name}]`, aggregate: 'sum', showLegend: false, palette: th.main, style: { fontSize: 8 } });
      rf.height = y + 230;
    }
  }
  b.pageFooter();
  return b.r;
}
