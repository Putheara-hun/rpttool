// Table helpers: merged cells (colSpan / rowSpan), cell ranges and structural edits that keep merges valid.
// A merged cell is the top-left ("owner") cell with colSpan / rowSpan > 1; the cells it covers stay in the
// grid (so rows always have one cell per column) but are not drawn.
import type { TableCell, TableElement } from './types';

export interface CellPos {
  row: number;
  col: number;
}
export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export const spanOf = (c: TableCell | undefined) => ({ cs: Math.max(1, Math.floor(c?.colSpan ?? 1)), rs: Math.max(1, Math.floor(c?.rowSpan ?? 1)) });
export const emptyCell = (): TableCell => ({ text: '', expression: '', format: '', summaryFunc: 'none', style: {} });

/** owners[r][c] = position of the cell that is drawn at (r, c) — itself, or the merged cell covering it */
export function cellOwners(t: TableElement): CellPos[][] {
  const R = t.rows.length;
  const C = t.columns.length;
  const own: (CellPos | null)[][] = Array.from({ length: R }, () => Array<CellPos | null>(C).fill(null));
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      if (own[r][c]) continue;
      own[r][c] = { row: r, col: c };
      const { cs, rs } = spanOf(t.rows[r].cells[c]);
      for (let rr = r; rr < Math.min(R, r + rs); rr++)
        for (let cc = c; cc < Math.min(C, c + cs); cc++) if (!own[rr][cc]) own[rr][cc] = { row: r, col: c };
    }
  return own as CellPos[][];
}

/** The cell drawn at a grid position (the merged cell's top-left when the position is covered). */
export function ownerOf(t: TableElement, row: number, col: number): CellPos {
  const r = Math.max(0, Math.min(t.rows.length - 1, row));
  const c = Math.max(0, Math.min(t.columns.length - 1, col));
  return cellOwners(t)[r]?.[c] ?? { row: r, col: c };
}

/** Effective span of an owner cell (clamped to the table and to cells already covered by earlier merges). */
export function effectiveSpan(t: TableElement, row: number, col: number, owners = cellOwners(t)): { cs: number; rs: number } {
  let cs = 0;
  while (col + cs < t.columns.length && owners[row][col + cs]?.row === row && owners[row][col + cs]?.col === col) cs++;
  let rs = 0;
  while (row + rs < t.rows.length && owners[row + rs][col]?.row === row && owners[row + rs][col]?.col === col) rs++;
  return { cs: Math.max(1, cs), rs: Math.max(1, rs) };
}

/** Rectangle of a cell (merged cells included), relative to the table. */
export function cellRectOf(t: TableElement, row: number, col: number, rowHeights?: number[]): { x: number; y: number; w: number; h: number } {
  const o = ownerOf(t, row, col);
  const { cs, rs } = effectiveSpan(t, o.row, o.col);
  const hs = rowHeights ?? t.rows.map((r) => r.height);
  const sum = (a: number[], from: number, to: number) => a.slice(from, to).reduce((s, v) => s + v, 0);
  return { x: sum(t.columns, 0, o.col), y: sum(hs, 0, o.row), w: sum(t.columns, o.col, o.col + cs), h: sum(hs, o.row, o.row + rs) };
}

/** The rectangle spanned by two cells, grown until no merged cell is cut in half. */
export function rangeOf(t: TableElement, a: CellPos, b: CellPos): CellRange {
  const owners = cellOwners(t);
  let r0 = Math.min(a.row, b.row);
  let r1 = Math.max(a.row, b.row);
  let c0 = Math.min(a.col, b.col);
  let c1 = Math.max(a.col, b.col);
  r0 = Math.max(0, r0);
  c0 = Math.max(0, c0);
  r1 = Math.min(t.rows.length - 1, r1);
  c1 = Math.min(t.columns.length - 1, c1);
  for (let changed = true; changed; ) {
    changed = false;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const o = owners[r][c];
        const { cs, rs } = effectiveSpan(t, o.row, o.col, owners);
        const nr0 = Math.min(r0, o.row);
        const nc0 = Math.min(c0, o.col);
        const nr1 = Math.max(r1, o.row + rs - 1);
        const nc1 = Math.max(c1, o.col + cs - 1);
        if (nr0 !== r0 || nc0 !== c0 || nr1 !== r1 || nc1 !== c1) {
          r0 = nr0;
          c0 = nc0;
          r1 = nr1;
          c1 = nc1;
          changed = true;
        }
      }
  }
  return { r0, c0, r1, c1 };
}

/** Owner cells inside a range (each merged cell once). */
export function cellsIn(t: TableElement, rg: CellRange): CellPos[] {
  const owners = cellOwners(t);
  const out: CellPos[] = [];
  const seen = new Set<string>();
  for (let r = rg.r0; r <= rg.r1; r++)
    for (let c = rg.c0; c <= rg.c1; c++) {
      const o = owners[r]?.[c];
      if (!o) continue;
      const k = o.row + ':' + o.col;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(o);
      }
    }
  return out;
}

const hasContent = (c: TableCell | undefined) => !!c && (!!c.text.trim() || !!c.expression.trim());

/**
 * Merge a range into its top-left cell. The top-left cell keeps its content; when it is empty the first
 * cell with content moves into it. Returns how many other cells had content (that content is dropped).
 */
export function mergeRange(t: TableElement, rg: CellRange): number {
  const top = t.rows[rg.r0].cells[rg.c0];
  let dropped = 0;
  let moved = hasContent(top);
  for (let r = rg.r0; r <= rg.r1; r++)
    for (let c = rg.c0; c <= rg.c1; c++) {
      if (r === rg.r0 && c === rg.c0) continue;
      const cell = t.rows[r].cells[c];
      if (!cell) continue;
      if (hasContent(cell)) {
        if (!moved) {
          Object.assign(top, { text: cell.text, expression: cell.expression, format: cell.format, summaryFunc: cell.summaryFunc });
          moved = true;
        } else dropped++;
      }
      Object.assign(cell, { text: '', expression: '', summaryFunc: 'none' });
      delete cell.colSpan;
      delete cell.rowSpan;
    }
  const cs = rg.c1 - rg.c0 + 1;
  const rs = rg.r1 - rg.r0 + 1;
  if (cs > 1) top.colSpan = cs;
  else delete top.colSpan;
  if (rs > 1) top.rowSpan = rs;
  else delete top.rowSpan;
  return dropped;
}

/** Split every merged cell inside a range back into single cells (the cells it covered take its style). */
export function unmergeRange(t: TableElement, rg: CellRange): number {
  let n = 0;
  for (const o of cellsIn(t, rg)) {
    const cell = t.rows[o.row].cells[o.col];
    const { cs, rs } = spanOf(cell);
    if (cs === 1 && rs === 1) continue;
    for (let r = o.row; r < Math.min(t.rows.length, o.row + rs); r++)
      for (let c = o.col; c < Math.min(t.columns.length, o.col + cs); c++) {
        if (r === o.row && c === o.col) continue;
        const cov = t.rows[r].cells[c];
        if (cov) cov.style = JSON.parse(JSON.stringify(cell.style ?? {}));
      }
    delete cell.colSpan;
    delete cell.rowSpan;
    n++;
  }
  return n;
}

/** Keep spans inside the table and free of overlaps (after rows / columns were removed, pasted, …). */
export function normalizeSpans(t: TableElement) {
  const R = t.rows.length;
  const C = t.columns.length;
  for (const row of t.rows) {
    while (row.cells.length < C) row.cells.push(emptyCell());
    if (row.cells.length > C) row.cells.length = C;
  }
  const covered = Array.from({ length: R }, () => Array<boolean>(C).fill(false));
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const cell = t.rows[r].cells[c];
      if (covered[r][c]) {
        delete cell.colSpan;
        delete cell.rowSpan;
        continue;
      }
      let { cs, rs } = spanOf(cell);
      cs = Math.min(cs, C - c);
      rs = Math.min(rs, R - r);
      // shrink until the area does not overlap an earlier merge
      const free = (h: number, w: number) => {
        for (let rr = r; rr < r + h; rr++) for (let cc = c; cc < c + w; cc++) if (covered[rr][cc]) return false;
        return true;
      };
      while (cs > 1 && !free(1, cs)) cs--;
      while (rs > 1 && !free(rs, cs)) rs--;
      for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) covered[rr][cc] = true;
      if (cs > 1) cell.colSpan = cs;
      else delete cell.colSpan;
      if (rs > 1) cell.rowSpan = rs;
      else delete cell.rowSpan;
    }
}

/** Insert a row at index `at`; merged cells crossing that line grow by one row. */
export function insertRow(t: TableElement, at: number, height: number, template?: TableCell[]) {
  const owners = cellOwners(t);
  const cells = t.columns.map((_, c) => {
    const base = template?.[c];
    const cell = base ? { ...JSON.parse(JSON.stringify(base)), text: '', expression: '', summaryFunc: 'none' as const } : emptyCell();
    delete cell.colSpan;
    delete cell.rowSpan;
    return cell as TableCell;
  });
  const grown = new Set<string>();
  if (at > 0 && at < t.rows.length)
    for (let c = 0; c < t.columns.length; c++) {
      const above = owners[at - 1][c];
      const below = owners[at][c];
      if (above.row === below.row && above.col === below.col && !grown.has(above.row + ':' + above.col)) {
        grown.add(above.row + ':' + above.col);
        const o = t.rows[above.row].cells[above.col];
        o.rowSpan = spanOf(o).rs + 1;
      }
    }
  t.rows.splice(at, 0, { height, cells });
  normalizeSpans(t);
}

/** Delete a row; a merged cell starting in it moves its content to the next row. */
export function deleteRow(t: TableElement, at: number) {
  if (t.rows.length <= 1) return;
  const owners = cellOwners(t);
  const done = new Set<string>();
  for (let c = 0; c < t.columns.length; c++) {
    const o = owners[at][c];
    const k = o.row + ':' + o.col;
    if (done.has(k)) continue;
    done.add(k);
    const cell = t.rows[o.row].cells[o.col];
    const { rs } = spanOf(cell);
    if (rs <= 1) continue;
    if (o.row < at) cell.rowSpan = rs - 1;
    else if (at + 1 < t.rows.length) {
      // the merged cell starts here: hand it over to the cell below
      const next = t.rows[at + 1].cells[o.col];
      Object.assign(next, JSON.parse(JSON.stringify(cell)));
      next.rowSpan = rs - 1;
    }
  }
  t.rows.splice(at, 1);
  normalizeSpans(t);
}

/** Insert a column at index `at` (width w); merged cells crossing that line grow by one column. */
export function insertCol(t: TableElement, at: number, w: number) {
  const owners = cellOwners(t);
  const grown = new Set<string>();
  t.rows.forEach((row, r) => {
    if (at > 0 && at < t.columns.length) {
      const left = owners[r][at - 1];
      const right = owners[r][at];
      const k = left.row + ':' + left.col;
      if (left.row === right.row && left.col === right.col && !grown.has(k)) {
        grown.add(k);
        const o = t.rows[left.row].cells[left.col];
        o.colSpan = spanOf(o).cs + 1;
      }
    }
    row.cells.splice(at, 0, emptyCell());
  });
  t.columns.splice(at, 0, w);
  normalizeSpans(t);
}

/** Delete a column; a merged cell starting in it moves its content to the next column. */
export function deleteCol(t: TableElement, at: number) {
  if (t.columns.length <= 1) return;
  const owners = cellOwners(t);
  const done = new Set<string>();
  for (let r = 0; r < t.rows.length; r++) {
    const o = owners[r][at];
    const k = o.row + ':' + o.col;
    if (done.has(k)) continue;
    done.add(k);
    const cell = t.rows[o.row].cells[o.col];
    const { cs } = spanOf(cell);
    if (cs <= 1) continue;
    if (o.col < at) cell.colSpan = cs - 1;
    else if (at + 1 < t.columns.length) {
      const next = t.rows[o.row].cells[at + 1];
      Object.assign(next, JSON.parse(JSON.stringify(cell)));
      next.colSpan = cs - 1;
    }
  }
  t.rows.forEach((row) => row.cells.splice(at, 1));
  t.columns.splice(at, 1);
  normalizeSpans(t);
}
