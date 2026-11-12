// Small UI-only state: context menu + helpers shared by designer components.
import { computed, reactive } from 'vue';
import { resolveStyle } from '../model/defaults';
import { cellsIn, rangeOf } from '../model/table';
import type { LineStyle, ReportElement, ResolvedStyle, StyleProps, TableElement } from '../model/types';
import { mutate, primaryElement, selectedElements, setElementProp, state } from '../store/designer';

export interface MenuItem {
  label?: string;
  icon?: any;
  kbd?: string;
  action?: () => void;
  disabled?: boolean;
  sep?: boolean;
  header?: string;
  /** submenu (opens on hover / click) */
  children?: MenuItem[];
  /** shows a check mark */
  checked?: boolean;
}

export const ctxMenu = reactive({ open: false, x: 0, y: 0, items: [] as MenuItem[] });
export function openContextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  ctxMenu.x = Math.min(e.clientX, window.innerWidth - 230);
  ctxMenu.y = Math.min(e.clientY, window.innerHeight - Math.min(520, items.length * 30 + 10));
  ctxMenu.items = items;
  ctxMenu.open = true;
}
export function closeContextMenu() {
  ctxMenu.open = false;
}

/** Effective (resolved) style of the current selection, used by ribbon font / alignment controls. */
export const selectionStyle = computed<ResolvedStyle | null>(() => {
  const el = primaryElement.value;
  if (!el) return null;
  const cell = state.selectedCell;
  if (cell && cell.id === el.id && el.type === 'table') {
    const c = (el as TableElement).rows[cell.row]?.cells[cell.col];
    return resolveStyle(state.report, el.styleName, el.style, c?.style);
  }
  return resolveStyle(state.report, el.styleName, el.style);
});

export const hasTextStyle = computed(() => selectedElements.value.some((e) => e.type !== 'line' && e.type !== 'shape'));

export function setStyle<K extends keyof StyleProps>(key: K, value: StyleProps[K] | undefined) {
  if (!state.selection.length) return;
  setElementProp('style.' + key, value);
}

/** Which property a ribbon colour button changes for each kind of control. */
function colorPath(el: ReportElement, kind: 'text' | 'fill' | 'border'): string | null {
  switch (el.type) {
    case 'line':
      return kind === 'fill' ? null : 'lineColor';
    case 'shape':
      return kind === 'fill' ? 'fillColor' : 'lineColor';
    case 'barcode':
      return kind === 'text' ? 'barColor' : kind === 'fill' ? 'style.backColor' : 'style.borderColor';
    default:
      return kind === 'text' ? 'style.color' : kind === 'fill' ? 'style.backColor' : 'style.borderColor';
  }
}

/** Current colours of the selection for the ribbon colour buttons (shape / line colours included). */
export const selectionColor = computed(() => {
  const el = primaryElement.value;
  const st = selectionStyle.value;
  const get = (kind: 'text' | 'fill' | 'border') => {
    if (!el) return undefined;
    const p = colorPath(el, kind);
    if (!p) return undefined;
    if (p.startsWith('style.') && st) return ((st as any)[p.slice(6)] as string) || undefined;
    return ((el as any)[p] as string) || undefined;
  };
  return { any: selectedElements.value.length > 0, text: get('text'), fill: get('fill'), border: get('border') };
});

/** Line style / width of the selection: a line or shape outline, otherwise the borders of text / cells. */
export const selectionLine = computed(() => {
  const el = primaryElement.value;
  if (!el) return null;
  if (el.type === 'line' || el.type === 'shape') return { style: el.lineStyle, width: el.lineWidth };
  const st = selectionStyle.value;
  return st ? { style: st.borderStyle, width: st.borderWidth } : null;
});

/** Solid / dashed / dotted for every selected control (lines and shapes: their line, others: their borders). */
export function applyLineStyle(value: LineStyle) {
  applyLine((el) => {
    if (el.type === 'line' || el.type === 'shape') el.lineStyle = value;
    else if (state.selectedCell?.id === el.id && el.type === 'table') return 'cell';
    else el.style.borderStyle = value;
  }, 'borderStyle', value);
}
/** Line width for every selected control (lines and shapes: their line, others: their borders). */
export function applyLineWidth(value: number) {
  applyLine((el) => {
    if (el.type === 'line' || el.type === 'shape') el.lineWidth = value;
    else if (state.selectedCell?.id === el.id && el.type === 'table') return 'cell';
    else el.style.borderWidth = value;
  }, 'borderWidth', value);
}
function applyLine(fn: (el: ReportElement) => 'cell' | void, cellKey: 'borderStyle' | 'borderWidth', value: unknown) {
  const ids = new Set(state.selection);
  const cell = state.selectedCell;
  mutate((r) => {
    for (const el of r.elements) {
      if (!ids.has(el.id)) continue;
      if (fn(el) === 'cell' && cell && el.type === 'table') {
        const rg = rangeOf(el, { row: cell.row, col: cell.col }, { row: cell.row2 ?? cell.row, col: cell.col2 ?? cell.col });
        for (const p of cellsIn(el, rg)) {
          const c = el.rows[p.row]?.cells[p.col];
          if (c) (c.style as any)[cellKey] = value;
        }
      }
    }
  });
}

/** Apply a ribbon colour to every selected control (or the selected table cell), as one undo step. */
export function applyColor(kind: 'text' | 'fill' | 'border', value: string | undefined) {
  const ids = new Set(state.selection);
  const cell = state.selectedCell;
  mutate((r) => {
    for (const el of r.elements) {
      if (!ids.has(el.id)) continue;
      if (cell && cell.id === el.id && el.type === 'table') {
        // the selected cell, or every cell of the selected range
        const rg = rangeOf(el, { row: cell.row, col: cell.col }, { row: cell.row2 ?? cell.row, col: cell.col2 ?? cell.col });
        for (const p of cellsIn(el, rg)) {
          const c = el.rows[p.row]?.cells[p.col];
          if (!c) continue;
          const key = kind === 'text' ? 'color' : kind === 'fill' ? 'backColor' : 'borderColor';
          if (value === undefined && kind !== 'fill') delete (c.style as any)[key];
          else (c.style as any)[key] = value ?? '';
        }
        continue;
      }
      const p = colorPath(el, kind);
      if (!p) continue;
      if (p.startsWith('style.')) {
        const key = p.slice(6) as keyof StyleProps;
        if (value === undefined && kind !== 'fill') delete el.style[key];
        else (el.style as any)[key] = value ?? '';
        if (kind === 'border' && value && !el.style.borders && !resolveStyle(r, el.styleName, el.style).borders) el.style.borders = 'tlbr';
      } else (el as any)[p] = value ?? (p === 'fillColor' ? '' : '#000000');
    }
  });
}
