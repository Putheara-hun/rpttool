<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
import type { RenderedDoc } from '../engine/doc';
import { paramValues, renderReport } from '../engine/renderer';
import { ensureReportFonts } from '../engine/fonts';
import { pageToSvg } from '../export/svg';
import type { Row } from '../model/types';
import { dataErrors, ensureData, rowsFor, state } from '../store/designer';
import { labels } from './labels';

/**
 * The Report Viewer's screen, in the look of the host application's own report viewer: one sheet at a time,
 * page navigation, zoom, find, export, print and refresh — no parameters panel (the application chooses the
 * criteria, runs its query and sends the rows).
 */
const emit = defineEmits<{ rendered: [pages: number]; failed: [message: string]; refresh: [] }>();
const L = labels;

const doc = shallowRef<RenderedDoc | null>(null);
const busy = ref(false);
const error = ref('');

// ---- paging
const page = ref(1);
const totalPages = computed(() => Math.max(1, doc.value?.pages.length ?? 1));
const goFirst = () => (page.value = 1);
const goPrev = () => page.value > 1 && page.value--;
const goNext = () => page.value < totalPages.value && page.value++;
const goLast = () => (page.value = totalPages.value);
function setPage(v: string | number) {
  const n = Math.trunc(Number(v));
  if (Number.isFinite(n)) page.value = Math.min(Math.max(1, n), totalPages.value);
}
watch(totalPages, () => {
  if (page.value > totalPages.value) page.value = totalPages.value;
});

// ---- zoom (percent, like the application's viewer)
const zoom = ref(100);
const scale = computed(() => zoom.value / 100);
function setZoom(v: string | number) {
  zoom.value = Math.min(200, Math.max(50, Math.trunc(Number(v)) || 100));
}

/** "12 records": the rows of the report's main data source */
const recordCount = computed(() => (state.report.dataSourceId ? rowsFor(state.report.dataSourceId).length : -1));
const recordsText = computed(() => `${recordCount.value} ${recordCount.value === 1 ? L.rpt_record : L.rpt_records}`);

// ---- find in report (every page)
const findOpen = ref(false);
const find = ref('');
const hitIdx = ref(0);
const findInput = ref<HTMLInputElement>();
const hits = computed(() => {
  const q = find.value.trim().toLowerCase();
  const out: { page: number; x: number; y: number; w: number; h: number }[] = [];
  if (!q || !doc.value) return out;
  doc.value.pages.forEach((p, pi) => {
    for (const pr of p.prims) if (pr.k === 'text' && pr.text.toLowerCase().includes(q)) out.push({ page: pi, x: pr.x, y: pr.y, w: pr.w, h: pr.h });
  });
  return out;
});
const findCountText = computed(() =>
  hits.value.length ? L.rpt_hit_of.replace('{a}', String(hitIdx.value + 1)).replace('{b}', String(hits.value.length)) : find.value.trim() ? L.rpt_no_matches : '',
);
function jumpToHit() {
  const h = hits.value[hitIdx.value];
  if (h) page.value = h.page + 1;
}
const nextHit = () => {
  if (!hits.value.length) return;
  hitIdx.value = (hitIdx.value + 1) % hits.value.length;
  jumpToHit();
};
const prevHit = () => {
  if (!hits.value.length) return;
  hitIdx.value = (hitIdx.value - 1 + hits.value.length) % hits.value.length;
  jumpToHit();
};
watch(find, () => {
  hitIdx.value = 0;
  jumpToHit();
});
function toggleFind() {
  findOpen.value = !findOpen.value;
  if (!findOpen.value) find.value = '';
  else setTimeout(() => findInput.value?.focus(), 0);
}

// ---- the sheet: the current page as SVG (lines on whole screen pixels at this zoom)
const sheet = computed(() => {
  const d = doc.value;
  const p = d?.pages[page.value - 1];
  if (!d || !p) return null;
  const hl = hits.value.filter((h) => h.page === page.value - 1).map((h) => ({ ...h, active: hits.value[hitIdx.value] === h }));
  return {
    w: p.width * scale.value,
    h: p.height * scale.value,
    svg: pageToSvg(p, { highlights: hl, scale: scale.value, pixelScale: scale.value * (window.devicePixelRatio || 1) }),
  };
});

async function generate(reloadData = false) {
  busy.value = true;
  error.value = '';
  try {
    await ensureData(reloadData);
    await ensureReportFonts(state.report); // web fonts must be loaded before text is measured
    await new Promise((r) => setTimeout(r, 10));
    const data: Record<string, Row[]> = {};
    for (const ds of state.report.dataSources) data[ds.id] = rowsFor(ds.id);
    const d = renderReport({ report: toRaw(state.report), data, params: paramValues(state.report, toRaw(state.paramValues)) });
    doc.value = markRaw(d);
    if (page.value > d.pages.length) page.value = Math.max(1, d.pages.length);
    emit('rendered', d.pages.length);
  } catch (e) {
    error.value = (e as Error).message;
    emit('failed', error.value);
  } finally {
    busy.value = false;
  }
}
function refresh() {
  find.value = '';
  hitIdx.value = 0;
  page.value = 1;
  emit('refresh'); // the application may send fresh rows
  void generate(true);
}

// ---- export / print
const exportOpen = ref(false);
const exportRoot = ref<HTMLElement>();
const onDocPointer = (e: MouseEvent) => {
  if (exportRoot.value && !exportRoot.value.contains(e.target as Node)) exportOpen.value = false;
};
async function exportAs(kind: 'pdf' | 'xlsx' | 'csv' | 'html' | 'png') {
  exportOpen.value = false;
  if (!doc.value) return;
  const ex = await import('../export');
  const base = ex.safeFileName(state.report.name);
  busy.value = true;
  try {
    await new Promise((r) => setTimeout(r, 10));
    if (kind === 'pdf') ex.downloadBlob(await ex.exportPdf(doc.value, state.report.name), base + '.pdf');
    else if (kind === 'xlsx') ex.downloadBlob(ex.exportXlsx(doc.value, state.report.name), base + '.xlsx');
    else if (kind === 'csv') ex.downloadBlob(ex.exportCsv(doc.value), base + '.csv');
    else if (kind === 'html') ex.downloadBlob(new Blob([ex.exportHtml(doc.value, state.report.name)], { type: 'text/html' }), base + '.html');
    else {
      const r = await ex.exportPng(doc.value, base);
      ex.downloadBlob(r.blob, r.name);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function print() {
  if (!doc.value) return;
  (await import('../export')).printDoc(doc.value, state.report.name);
}

// arrow keys / Page Up / Page Down turn pages (not while typing)
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t?.closest?.('input, textarea, select')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goNext();
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPrev();
  else if (e.key === 'Home') goFirst();
  else if (e.key === 'End') goLast();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (!findOpen.value) toggleFind();
    else findInput.value?.focus();
  } else return;
}

defineExpose({ generate, print, exportAs });
onMounted(() => {
  document.addEventListener('mousedown', onDocPointer);
  window.addEventListener('keydown', onKey);
  void generate();
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointer);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="rv">
    <div class="rv-bar">
      <button class="vbtn" :disabled="page === 1" :title="L.rpt_first_page" @click="goFirst">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 17 13 12l5-5M7 6v12" /></svg>
      </button>
      <button class="vbtn" :disabled="page === 1" :title="L.rpt_prev_page" @click="goPrev">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </button>
      <input class="pagebox tnum" type="text" :value="page" :title="L.rpt_page_number" @change="setPage(($event.target as HTMLInputElement).value)" />
      <span class="pageof">{{ L.rpt_of }} {{ totalPages }}</span>
      <button class="vbtn" :disabled="page === totalPages" :title="L.rpt_next_page" @click="goNext">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <button class="vbtn" :disabled="page === totalPages" :title="L.rpt_last_page" @click="goLast">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 17 5-5-5-5M17 6v12" /></svg>
      </button>

      <div class="vsep" />

      <input class="zoombox tnum" type="text" :value="zoom" :title="L.rpt_zoom_pct" @change="setZoom(($event.target as HTMLInputElement).value)" />
      <input v-model.number="zoom" class="zoomslider" type="range" min="50" max="200" step="5" :title="L.rpt_zoom" />

      <div class="vsep" />

      <div ref="exportRoot" class="exp">
        <button class="vbtn" :class="{ on: exportOpen }" :disabled="!doc" :title="L.rpt_export" @click="exportOpen = !exportOpen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16" /></svg>
          <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="exportOpen" class="exp-menu">
          <button type="button" @click="exportAs('xlsx')">{{ L.rpt_export_excel }}</button>
          <button type="button" @click="exportAs('pdf')">{{ L.rpt_export_pdf }}</button>
          <button type="button" @click="exportAs('html')">{{ L.rpt_export_html }}</button>
          <button type="button" @click="exportAs('csv')">{{ L.rpt_export_csv }}</button>
          <button type="button" @click="exportAs('png')">{{ L.rpt_export_png }}</button>
        </div>
      </div>
      <button class="vbtn" :disabled="!doc" :title="L.rpt_print" @click="print">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z" /></svg>
      </button>
      <button class="vbtn" :class="{ on: findOpen }" :title="L.rpt_find" @click="toggleFind">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3-3" /></svg>
      </button>
      <button class="vbtn" :title="L.rpt_refresh" @click="refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
      </button>

      <div class="vspacer" />
      <slot name="actions" />
      <span v-if="recordCount >= 0" class="vcount">{{ recordsText }}</span>
    </div>

    <div v-if="findOpen" class="find-bar">
      <input ref="findInput" v-model="find" :placeholder="L.rpt_find_placeholder" @keydown.enter="$event.shiftKey ? prevHit() : nextHit()" @keydown.esc="toggleFind" />
      <span class="find-count">{{ findCountText }}</span>
      <button class="vbtn" :disabled="!hits.length" :title="L.rpt_prev_match" @click="prevHit">‹</button>
      <button class="vbtn" :disabled="!hits.length" :title="L.rpt_next_match" @click="nextHit">›</button>
      <button class="vbtn" :title="L.rpt_close" @click="toggleFind">✕</button>
    </div>

    <div v-if="error" class="rv-msg err">{{ error }}</div>
    <template v-for="ds in state.report.dataSources" :key="ds.id">
      <div v-if="dataErrors[ds.id]" class="rv-msg err">{{ L.rpt_data_source }} "{{ ds.name }}": {{ dataErrors[ds.id] }}</div>
    </template>
    <div v-for="w in doc?.warnings ?? []" :key="w" class="rv-msg">{{ w }}</div>

    <div class="rv-body">
      <!-- a document preview: the sheet stays light in dark mode, as it prints -->
      <div v-if="sheet" class="rv-sheet" :style="{ width: sheet.w + 'px', height: sheet.h + 'px' }" v-html="sheet.svg" />
      <div v-else-if="!busy && !error" class="rv-empty">{{ L.rpt_no_data }}</div>
    </div>
    <div v-if="busy" class="rv-busy"><span class="rv-spin" /> {{ L.rpt_loading }}</div>
  </div>
</template>

<style scoped>
.rv {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  color: var(--ink);
}
.rv-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface-2);
}
.vbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
}
.vbtn svg {
  width: 16px;
  height: 16px;
}
.vbtn svg.caret {
  width: 11px;
  height: 11px;
  opacity: 0.7;
}
.vbtn:hover:not(:disabled),
.vbtn.on {
  background: var(--teal-soft);
  color: var(--teal-deep);
  border-color: var(--border-soft);
}
.vbtn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pagebox,
.zoombox {
  width: 46px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font-family: inherit;
  font-size: 12.5px;
  text-align: center;
}
.tnum {
  font-variant-numeric: tabular-nums;
}
.pageof {
  padding: 0 4px;
  color: var(--muted);
  font-size: 12.5px;
  white-space: nowrap;
}
.zoomslider {
  width: 110px;
  accent-color: var(--teal-deep);
  cursor: pointer;
}
.vsep {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: var(--border-soft);
}
.vspacer {
  flex: 1;
}
.vcount {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  padding-left: 6px;
}
.exp {
  position: relative;
}
.exp-menu {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  left: 0;
  min-width: 150px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.exp-menu button {
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--ink);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  text-align: left;
}
.exp-menu button:hover {
  background: var(--teal-soft);
  color: var(--teal-deep);
}
.find-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface);
}
.find-bar input {
  width: 240px;
  max-width: 50vw;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}
.find-count {
  min-width: 80px;
  color: var(--muted);
  font-size: 12px;
}
.rv-msg {
  padding: 6px 14px;
  font-size: 12.5px;
  background: var(--amber-soft);
  color: var(--ink);
  border-bottom: 1px solid var(--border-soft);
}
.rv-msg.err {
  background: var(--red-soft);
}
.rv-body {
  flex: 1;
  min-height: 0;
  padding: 20px;
  background: var(--surface-2);
  overflow: auto;
}
.rv-sheet {
  margin: 0 auto;
  background: #fff;
  border: 1px solid #d8dce6;
  border-radius: 4px;
  box-shadow: 0 6px 22px rgba(15, 23, 42, 0.12);
  overflow: hidden;
}
.rv-sheet :deep(svg) {
  display: block;
}
.rv-empty {
  padding: 60px 0;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
}
.rv-busy {
  position: absolute;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  font-size: 13px;
}
.rv-spin {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--teal);
  border-radius: 50%;
  animation: rv-spin 0.8s linear infinite;
}
@keyframes rv-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
