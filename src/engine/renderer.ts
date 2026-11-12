// Report renderer: data processing (filter / sort / group) and pagination.
import type { Band, BandType, DetailReportDef, ParameterDef, ReportDef, Row } from '../model/types';
import { childDetailReports, detailReportDepth } from '../model/defaults';
import type { Bookmark, CellInfo, Prim, RenderedDoc, RenderedPage } from './doc';
import { primBounds, shiftCell, shiftPrim } from './doc';
import { compareValues, evalExpr, getField, parse, truthy, type EvalContext, type Node } from './expression';
import { isDate, parseDate } from './format';
import { bandVisible, layoutBand, type BandLayout, type LayoutEnv } from './layout';

export interface RenderInput {
  report: ReportDef;
  data: Record<string, Row[]>;
  params: Record<string, unknown>;
  maxPages?: number;
}

class PageLimit extends Error {}

export function typedParam(p: ParameterDef, raw: unknown): unknown {
  if (raw === undefined || raw === null) raw = p.defaultValue;
  switch (p.type) {
    case 'number': {
      if (raw === '' || raw === null) return null;
      const n = Number(raw);
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return raw === true || String(raw).toLowerCase() === 'true' || raw === '1';
    case 'date':
      return parseDate(raw);
    default:
      return raw === null ? '' : String(raw);
  }
}

export function paramValues(r: ReportDef, values: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of r.parameters) out[p.name] = typedParam(p, p.name in values ? values[p.name] : undefined);
  return out;
}

export function compileCalcFields(r: ReportDef, warnings?: string[]): Map<string, Node> {
  const calc = new Map<string, Node>();
  for (const cf of r.calculatedFields) {
    if (!cf.name) continue;
    try {
      calc.set(cf.name.toLowerCase(), parse(cf.expression || 'null'));
    } catch (e) {
      warnings?.push(`Calculated field "${cf.name}": ${(e as Error).message}`);
    }
  }
  return calc;
}

/** Filter & sort the main data source rows of a report. */
export function prepareRows(r: ReportDef, data: Record<string, Row[]>, baseCtx: EvalContext, warnings: string[]): Row[] {
  let rows = (r.dataSourceId && data[r.dataSourceId]) || [];
  if (r.filter && r.filter.trim()) {
    try {
      const node = parse(r.filter);
      void node;
      rows = rows.filter((row) => {
        const v = evalExpr(r.filter, { ...baseCtx, row, rows: [] });
        return typeof v === 'string' && v.startsWith('#Error') ? true : truthy(v);
      });
    } catch (e) {
      warnings.push('Filter: ' + (e as Error).message);
    }
  }
  const keys = [
    ...r.groups.filter((g) => g.sort !== 'none' && g.expression).map((g) => ({ expr: g.expression, dir: g.sort === 'desc' ? -1 : 1 })),
    ...r.sort.filter((s) => s.expression).map((s) => ({ expr: s.expression, dir: s.dir === 'desc' ? -1 : 1 })),
  ];
  return sortRows(rows, keys, baseCtx);
}

/** Stable sort of rows by expression keys. */
export function sortRows(rows: Row[], keys: { expr: string; dir: number }[], baseCtx: EvalContext): Row[] {
  if (!keys.length) return rows;
  const dec = rows.map((row, i) => ({ row, i, k: keys.map((k) => evalExpr(k.expr, { ...baseCtx, row, rows: [] })) }));
  dec.sort((a, b) => {
    for (let j = 0; j < keys.length; j++) {
      const c = compareValues(a.k[j], b.k[j]);
      if (c) return c * keys[j].dir;
    }
    return a.i - b.i;
  });
  return dec.map((d) => d.row);
}

function partition(rows: Row[], expr: string, ctx: EvalContext): Row[][] {
  const out: Row[][] = [];
  let prev: unknown = undefined;
  let cur: Row[] | null = null;
  for (const row of rows) {
    const k = expr ? evalExpr(expr, { ...ctx, row }) : null;
    if (!cur || compareValues(k, prev) !== 0 || (typeof k === 'string' && typeof prev === 'string' && k !== prev)) {
      cur = [];
      out.push(cur);
      prev = k;
    }
    cur.push(row);
  }
  return out;
}

const isAtomic = (p: Prim) => {
  if (p.k === 'rect') return false;
  if (p.k === 'line') return !(p.x1 === p.x2);
  return true;
};

function findBreak(prims: Prim[], avail: number): number {
  let b = avail;
  for (let iter = 0; iter < 100; iter++) {
    let moved = false;
    for (const p of prims) {
      if (!isAtomic(p)) continue;
      const bb = primBounds(p);
      if (bb.y < b - 0.01 && bb.y + bb.h > b + 0.01) {
        b = bb.y;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return b <= 0.5 ? avail : b;
}

function splitLayout(L: BandLayout, b: number): [BandLayout, BandLayout] {
  const top: Prim[] = [];
  const rest: Prim[] = [];
  for (const p of L.prims) {
    const bb = primBounds(p);
    if (bb.y + bb.h <= b + 0.01) top.push(p);
    else if (bb.y >= b - 0.01) rest.push(shiftPrim(p, 0, -b));
    else if (p.k === 'rect') {
      top.push({ ...p, h: b - p.y });
      rest.push({ ...p, y: 0, h: p.y + p.h - b });
    } else if (p.k === 'line' && p.x1 === p.x2) {
      const y0 = Math.min(p.y1, p.y2);
      const y1 = Math.max(p.y1, p.y2);
      top.push({ ...p, y1: y0, y2: b });
      rest.push({ ...p, y1: 0, y2: y1 - b });
    } else top.push(p); // forced break through an atomic item
  }
  const cells = (pred: (c: CellInfo) => boolean, dy: number) => L.cells.filter(pred).map((c) => shiftCell(c, 0, dy));
  return [
    { height: b, prims: top, cells: cells((c) => c.y < b, 0), bookmarks: L.bookmarks.filter((x) => x.y < b) },
    {
      height: L.height - b,
      prims: rest,
      cells: cells((c) => c.y >= b, -b),
      bookmarks: L.bookmarks.filter((x) => x.y >= b).map((x) => ({ ...x, y: x.y - b })),
    },
  ];
}

interface PageState {
  prims: Prim[];
  cells: CellInfo[];
  rows: Row[];
  hasBody: boolean;
  top: number;
}

export function renderReport(inp: RenderInput): RenderedDoc {
  const t0 = performance.now();
  const r = inp.report;
  const warnings: string[] = [];
  const maxPages = inp.maxPages ?? 5000;
  const calc = compileCalcFields(r, warnings);
  const fmt = { locale: r.locale || 'en-US', currency: r.currency || 'USD' };
  const baseCtx: EvalContext = { row: null, rows: [], params: inp.params, calc, reportName: r.name, fmt };
  const rows = prepareRows(r, inp.data, baseCtx, warnings);

  const { width: pw, height: ph, margins: m } = r.page;
  const contentW = pw - m.left - m.right;
  const band = (t: BandType) => r.bands.find((b) => b.type === t);
  const phBand = band('pageHeader');
  const pfBand = band('pageFooter');
  const phH = phBand && phBand.visible ? phBand.height : 0;
  const pfH = pfBand && pfBand.visible ? pfBand.height : 0;
  const rhBand = band('reportHeader');
  // On the first page the page header prints below the report header (DevExpress / Crystal behaviour).
  const phAfterRH = !!(phBand && phBand.visible && phBand.printOnFirstPage !== false && rhBand && rhBand.visible);
  let firstHeaderY: number | null = null;
  const bodyTop = (index: number) => m.top + (phBand && phBand.visible && (index > 0 || (phBand.printOnFirstPage !== false && !phAfterRH)) ? phH : 0);
  // Roll paper (auto height): a single continuous page, no page breaks; its height is set at the end.
  const roll = !!r.page.autoHeight;
  const bodyBottom = roll ? 1e9 : ph - m.bottom - pfH;
  if (bodyBottom - bodyTop(1) < 20) warnings.push('Page margins and page header/footer leave no room for content.');

  const pages: PageState[] = [];
  const bookmarks: Bookmark[] = [];
  let cur!: PageState;
  let y = 0;
  let pendingBreak = false;
  const openGroups: { band: Band | null; env: LayoutEnv | null }[] = [];
  let repeating = false;

  const mkEnv = (bandType: BandType, ctx: Partial<EvalContext>, running?: LayoutEnv['running']): LayoutEnv => ({
    report: r,
    design: false,
    bandType,
    ctx: { ...baseCtx, ...ctx, page: pages.length },
    running,
  });

  const levelOf = (bt: BandType, lvl: number) => (bt === 'groupHeader' ? lvl : bt === 'detail' ? r.groups.length : 0);

  const emit = (L: BandLayout, level: number) => {
    for (const p of L.prims) cur.prims.push(shiftPrim(p, m.left, y));
    for (const c of L.cells) cur.cells.push(shiftCell(c, m.left, y));
    for (const b of L.bookmarks) bookmarks.push({ text: b.text, page: pages.length - 1, y: y + b.y, level });
    y += L.height;
    if (L.height > 0 || L.prims.length) cur.hasBody = true;
  };

  const startPage = () => {
    if (pages.length >= maxPages) throw new PageLimit();
    cur = { prims: [], cells: [], rows: [], hasBody: false, top: bodyTop(pages.length) };
    pages.push(cur);
    y = cur.top;
    if (pages.length > 1 && !repeating) {
      repeating = true;
      try {
        openGroups.forEach((g, lvl) => {
          if (g.band && g.env && g.band.repeatEveryPage) {
            const L = layoutBand(g.band, r.elements, { ...g.env, ctx: { ...g.env.ctx, page: pages.length } }, contentW);
            if (L.height <= bodyBottom - y) emit({ ...L, bookmarks: [] }, lvl);
          }
        });
      } finally {
        repeating = false;
      }
      cur.hasBody = false;
    }
  };

  const place = (L: BandLayout, b: Band, level: number, row?: Row) => {
    if (L.height <= 0 && !L.prims.length) return;
    if (pendingBreak) {
      pendingBreak = false;
      if (cur.hasBody) startPage();
    }
    if (b.pageBreakBefore && cur.hasBody && !roll) startPage();
    const fresh = bodyBottom - bodyTop(1);
    if (L.height > bodyBottom - y + 0.01 && cur.hasBody && (b.keepTogether || L.height <= fresh)) startPage();
    if (row) cur.rows.push(row);
    let guard = 0;
    while (L.height > bodyBottom - y + 0.01 && guard++ < 10000) {
      const avail = bodyBottom - y;
      if (avail < 1) {
        if (cur.hasBody) {
          startPage();
          continue;
        }
        break; // nothing fits even on an empty page: overflow
      }
      const br = findBreak(L.prims, avail);
      const [a, rest] = splitLayout(L, br);
      emit(a, level);
      startPage();
      L = rest;
    }
    emit(L, level);
    if (b.pageBreakAfter && !roll) pendingBreak = true;
  };

  /** an empty repeating band (no controls, no colours) takes no space — e.g. when all lists are detail-report sections */
  const isEmptyBand = (b: Band | null | undefined) => !!b && !b.backColor && !b.evenRowColor && !r.elements.some((e) => e.bandId === b.id);
  const detailBand = band('detail');
  const detail = isEmptyBand(detailBand) ? undefined : detailBand;
  let recordIndex = 0;
  const runReport: Row[] = [];
  let runGroup: Row[] = [];

  const processLevel = (level: number, groupRows: Row[]) => {
    if (level >= r.groups.length) {
      if (level === 0) runGroup = [];
      for (let i = 0; i < groupRows.length; i++) {
        const row = groupRows[i];
        runReport.push(row);
        runGroup.push(row);
        if (detail) {
          const rg = runGroup;
          const pageRows = cur.rows;
          const nReport = runReport.length;
          const nGroup = rg.length;
          const running = {
            get group() {
              return rg.slice(0, nGroup);
            },
            get page() {
              return [...pageRows, row];
            },
            get report() {
              return runReport.slice(0, nReport);
            },
          };
          const env = mkEnv('detail', { row, rows: groupRows, rowIndex: i, recordIndex }, running);
          if (bandVisible(detail, env)) {
            const bg = i % 2 === 1 && detail.evenRowColor ? detail.evenRowColor : undefined;
            place(layoutBand(detail, r.elements, env, contentW, bg), detail, levelOf('detail', level), row);
          } else cur.rows.push(row);
        } else cur.rows.push(row);
        // master–detail sections printed under every main row
        for (const d of childDetailReports(r, null, 'perRow')) renderDetailReport(d, row);
        recordIndex++;
      }
      return;
    }
    const g = r.groups[level];
    const header = r.bands.find((b) => b.type === 'groupHeader' && b.groupId === g.id) ?? null;
    const footer = r.bands.find((b) => b.type === 'groupFooter' && b.groupId === g.id) ?? null;
    for (const part of partition(groupRows, g.expression, baseCtx)) {
      if (level === r.groups.length - 1) runGroup = [];
      let headerEnv: LayoutEnv | null = null;
      if (header) {
        headerEnv = mkEnv('groupHeader', { row: part[0], rows: part, rowIndex: 0, recordIndex });
        if (bandVisible(header, headerEnv)) {
          const HL = layoutBand(header, r.elements, headerEnv, contentW);
          if (g.keepWithFirstDetail && cur.hasBody) {
            let need = HL.height + (detail?.height ?? 0);
            for (let k = level + 1; k < r.groups.length; k++) need += r.bands.find((b) => b.type === 'groupHeader' && b.groupId === r.groups[k].id)?.height ?? 0;
            if (need > bodyBottom - y) startPage();
          }
          place(HL, header, level);
        }
      }
      openGroups.push({ band: header, env: headerEnv });
      processLevel(level + 1, part);
      if (footer) {
        const fenv = mkEnv('groupFooter', { row: part[part.length - 1], rows: part, recordIndex });
        if (bandVisible(footer, fenv)) place(layoutBand(footer, r.elements, fenv, contentW), footer, level);
      }
      openGroups.pop();
    }
  };

  // ---------------------------------------------------------------- detail reports
  const drBand = (d: DetailReportDef, t: BandType) => r.bands.find((b) => b.type === t && b.detailReportId === d.id) ?? null;
  const ctxRow = (row: Row | null): EvalContext => ({ ...baseCtx, row, rows: [] });
  /** a key part: plain field name, or an expression when it contains [ ( ? or quotes */
  const keyValue = (row: Row, k: string) => (/[[(?'"]/.test(k) ? evalExpr(k, ctxRow(row)) : getField(ctxRow(row), k));
  const norm = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '\u0000';
    if (isDate(v)) return 'd' + v.getTime();
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))) return 'n' + Number(v);
    if (typeof v === 'boolean') return 'b' + v;
    return 's' + String(v).trim().toLowerCase();
  };
  const drCache = new Map<string, { rows: Row[]; index: Map<string, Row[]> | null }>();
  const drData = (d: DetailReportDef) => {
    let c = drCache.get(d.id);
    if (!c) {
      let list = (d.dataSourceId && inp.data[d.dataSourceId]) || [];
      list = sortRows(list, d.sort.filter((s) => s.expression).map((s) => ({ expr: s.expression, dir: s.dir === 'desc' ? -1 : 1 })), baseCtx);
      const keys = d.keys.filter((k) => k.master && k.child);
      let index: Map<string, Row[]> | null = null;
      if (keys.length) {
        index = new Map();
        for (const row of list) {
          const key = keys.map((k) => norm(keyValue(row, k.child))).join('\u0001');
          (index.get(key) ?? index.set(key, []).get(key)!).push(row);
        }
      }
      c = { rows: list, index };
      drCache.set(d.id, c);
    }
    return c;
  };

  /** Print a detail report section: header, one detail band per row (+ nested sections), footer. */
  function renderDetailReport(d: DetailReportDef, master: Row | null) {
    const data = drData(d);
    const keys = d.keys.filter((k) => k.master && k.child);
    let list = data.rows;
    if (master && data.index) list = data.index.get(keys.map((k) => norm(keyValue(master, k.master))).join('\u0001')) ?? [];
    // inside the section the parent row is available as [Master.Field]
    let rowsD = master ? list.map((row) => ({ ...row, Master: master })) : list;
    if (d.filter && d.filter.trim()) {
      rowsD = rowsD.filter((row) => {
        const v = evalExpr(d.filter, ctxRow(row));
        return typeof v === 'string' && v.startsWith('#Error') ? true : truthy(v);
      });
    }
    if (!rowsD.length && d.printMode === 'perRow') return;
    const header = drBand(d, 'drHeader');
    const detBand = drBand(d, 'drDetail');
    const det = isEmptyBand(detBand) ? null : detBand;
    const footer = drBand(d, 'drFooter');
    const first = rowsD[0] ?? (master ? { Master: master } : null);
    const level = r.groups.length + detailReportDepth(r, d.id);
    let headerEnv: LayoutEnv | null = null;
    if (header) {
      headerEnv = mkEnv('drHeader', { row: first, rows: rowsD });
      if (bandVisible(header, headerEnv)) {
        const HL = layoutBand(header, r.elements, headerEnv, contentW);
        // keep the header together with the first row
        if (cur.hasBody && det && HL.height + det.height > bodyBottom - y) startPage();
        place(HL, header, level);
      }
    }
    openGroups.push({ band: header, env: headerEnv });
    for (let i = 0; i < rowsD.length; i++) {
      const row = rowsD[i];
      if (det) {
        const env = mkEnv('drDetail', { row, rows: rowsD, rowIndex: i, recordIndex: i });
        if (bandVisible(det, env)) {
          const bg = i % 2 === 1 && det.evenRowColor ? det.evenRowColor : undefined;
          place(layoutBand(det, r.elements, env, contentW, bg), det, level);
        }
      }
      for (const c of childDetailReports(r, d.id, 'perRow')) renderDetailReport(c, row);
    }
    for (const c of childDetailReports(r, d.id, 'once')) renderDetailReport(c, null);
    openGroups.pop();
    if (footer) {
      const env = mkEnv('drFooter', { row: rowsD[rowsD.length - 1] ?? first, rows: rowsD });
      if (bandVisible(footer, env)) place(layoutBand(footer, r.elements, env, contentW), footer, level);
    }
  }

  startPage();
  try {
    const rh = rhBand;
    if (rh) {
      const env = mkEnv('reportHeader', { row: rows[0] ?? null, rows });
      if (bandVisible(rh, env)) place(layoutBand(rh, r.elements, env, contentW), rh, 0);
    }
    if (phAfterRH && pages.length === 1) {
      firstHeaderY = y;
      y += phH;
      cur.hasBody = true;
    }
    if (rows.length) processLevel(0, rows);
    // independent sections printed once after the main rows
    for (const d of childDetailReports(r, null, 'once')) renderDetailReport(d, null);
    const rf = band('reportFooter');
    if (rf) {
      const env = mkEnv('reportFooter', { row: rows[rows.length - 1] ?? null, rows });
      if (bandVisible(rf, env)) place(layoutBand(rf, r.elements, env, contentW), rf, 0);
    }
  } catch (e) {
    if (e instanceof PageLimit) warnings.push(`Rendering stopped after ${maxPages} pages.`);
    else throw e;
  }

  // ---- page headers / footers and deferred (page number dependent) content
  const pageCount = pages.length;
  const contentEnd = y;
  const pageH = roll ? Math.max(Math.ceil(contentEnd + pfH + m.bottom), Math.ceil(m.top + m.bottom + 20)) : ph;
  const footerTop = roll ? contentEnd : ph - m.bottom - pfH;
  const out: RenderedPage[] = pages.map((pg, i) => {
    const page = i + 1;
    const isFirst = i === 0;
    const isLast = i === pageCount - 1;
    const ctx: EvalContext = { ...baseCtx, rows: pg.rows, row: pg.rows[0] ?? rows[0] ?? null, page, pageCount };
    const extra: Prim[] = [];
    const drawPB = (b: Band | undefined, top: number, bt: BandType) => {
      if (!b || !b.visible) return;
      if (isFirst && b.printOnFirstPage === false) return;
      if (isLast && b.printOnLastPage === false) return;
      const env: LayoutEnv = { report: r, ctx, design: false, bandType: bt, pageScoped: true };
      if (!bandVisible(b, env)) return;
      const L = layoutBand(b, r.elements, env, contentW);
      for (const p of L.prims) extra.push(shiftPrim(p, m.left, top));
      for (const c of L.cells) pg.cells.push(shiftCell({ ...c, band: bt }, m.left, top));
    };
    if (i === 0 && phAfterRH) {
      if (firstHeaderY !== null) drawPB(phBand, firstHeaderY, 'pageHeader');
    } else drawPB(phBand, m.top, 'pageHeader');
    drawPB(pfBand, footerTop, 'pageFooter');
    const prims: Prim[] = [];
    for (const p of [...pg.prims, ...extra]) {
      if (p.k === 'defer') {
        for (const q of p.render(page, pageCount)) prims.push(shiftPrim(q, p.x, p.y));
      } else prims.push(p);
    }
    return { width: pw, height: pageH, prims, cells: pg.cells, watermark: r.watermark?.enabled ? r.watermark : undefined };
  });
  // Auto width: widen the paper when printed content (e.g. a wide cross tab or table) passes the right margin.
  if (r.page.autoWidth) {
    let right = 0;
    for (const pg of out) {
      for (const p of pg.prims) {
        const b = primBounds(p);
        right = Math.max(right, b.x + b.w);
      }
    }
    const w = Math.ceil(right + m.right);
    if (w > pw) for (const pg of out) pg.width = w;
  }
  return { pages: out, bookmarks, warnings, timeMs: performance.now() - t0 };
}
