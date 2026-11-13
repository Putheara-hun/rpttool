<script setup lang="ts">
import { computed, markRaw, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
import {
  BookOpen,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Printer,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-vue-next';
import type { RenderedDoc } from '../engine/doc';
import { paramValues, renderReport } from '../engine/renderer';
import type { Row } from '../model/types';
import { pageToSvg } from '../export/svg';
import { ensureReportFonts } from '../engine/fonts';
import { dataErrors, ensureData, notify, rowsFor, state } from '../store/designer';

/** rendered: the pages are ready (the Report Viewer tells its host system) */
const emit = defineEmits<{ rendered: [pages: number]; failed: [message: string] }>();

const doc = shallowRef<RenderedDoc | null>(null);
const busy = ref(false);
const busyText = ref('Generating report…');
const error = ref('');
const zoomMode = ref<number | 'width' | 'page'>('width');
const container = ref<HTMLElement>();
const scrollTop = ref(0);
const viewW = ref(800);
const viewH = ref(600);
const showSide = ref<'params' | 'map' | null>(null);
const exportOpen = ref(false);
const query = ref('');
const matches = ref<{ page: number; x: number; y: number; w: number; h: number }[]>([]);
const matchIdx = ref(0);
const GAP = 18;
const TOP_PAD = 20;

const visibleParams = computed(() => state.report.parameters.filter((p) => p.visible));

async function generate(reloadData = false) {
  busy.value = true;
  busyText.value = state.report.dataSources.some((d) => d.kind === 'sql') ? 'Querying database…' : 'Loading data…';
  error.value = '';
  try {
    await ensureData(reloadData);
    // web fonts must be loaded before text is measured
    busyText.value = 'Loading fonts…';
    await ensureReportFonts(state.report);
    busyText.value = 'Generating report…';
    await new Promise((r) => setTimeout(r, 20));
    const data: Record<string, Row[]> = {};
    for (const ds of state.report.dataSources) data[ds.id] = rowsFor(ds.id);
    const d = renderReport({ report: toRaw(state.report), data, params: paramValues(state.report, toRaw(state.paramValues)) });
    doc.value = markRaw(d);
    svgCache.clear();
    matches.value = [];
    emit('rendered', d.pages.length);
  } catch (e) {
    error.value = (e as Error).message;
    console.error(e);
    emit('failed', error.value);
  } finally {
    busy.value = false;
  }
}

const pageW = computed(() => doc.value?.pages[0]?.width ?? state.report.page.width);
const pageH = computed(() => doc.value?.pages[0]?.height ?? state.report.page.height);
const scale = computed(() => {
  const z = zoomMode.value;
  if (typeof z === 'number') return z;
  const fitW = (viewW.value - 60) / pageW.value;
  if (z === 'width') return Math.max(0.2, Math.min(fitW, 2.5));
  return Math.max(0.1, Math.min(fitW, (viewH.value - 50) / pageH.value));
});
const stride = computed(() => pageH.value * scale.value + GAP);
const pageCount = computed(() => doc.value?.pages.length ?? 0);
const currentPage = computed(() => Math.min(pageCount.value, Math.max(1, Math.floor((scrollTop.value + viewH.value / 3 - TOP_PAD) / stride.value) + 1)));
const inRange = (i: number) => {
  const first = Math.floor((scrollTop.value - TOP_PAD) / stride.value) - 1;
  const last = Math.ceil((scrollTop.value + viewH.value) / stride.value) + 1;
  return i >= first && i <= last;
};

const svgCache = new Map<number, string>();
function svgOf(i: number) {
  let s = svgCache.get(i);
  if (s === undefined) {
    const hl = matches.value.filter((m) => m.page === i).map((m) => ({ ...m, active: matches.value[matchIdx.value] === m }));
    // lines get whole-screen-pixel widths at the current zoom (even, sharp table lines)
    s = pageToSvg(doc.value!.pages[i], { highlights: hl, pixelScale: scale.value * (window.devicePixelRatio || 1) });
    svgCache.set(i, s);
  }
  return s;
}
watch([matches, matchIdx, scale], () => svgCache.clear());

function onScroll() {
  scrollTop.value = container.value?.scrollTop ?? 0;
}
function measure() {
  if (!container.value) return;
  viewW.value = container.value.clientWidth;
  viewH.value = container.value.clientHeight;
}
function goto(p: number, y = 0) {
  if (!container.value || !pageCount.value) return;
  const n = Math.min(pageCount.value, Math.max(1, p));
  container.value.scrollTop = TOP_PAD + (n - 1) * stride.value + y * scale.value - 20;
}
function setZoom(z: number | 'width' | 'page') {
  const p = currentPage.value;
  zoomMode.value = typeof z === 'number' ? Math.min(4, Math.max(0.1, Math.round(z * 100) / 100)) : z;
  requestAnimationFrame(() => goto(p));
}

let lastQuery = '';
function onZoomSelect(v: string) {
  setZoom(v === 'width' || v === 'page' ? v : Number(v));
}
function runSearch(dir = 1) {
  const q = query.value.trim().toLowerCase();
  if (!doc.value || !q) {
    matches.value = [];
    return;
  }
  if (!matches.value.length || lastQuery !== q) {
    const found: typeof matches.value = [];
    doc.value.pages.forEach((p, pi) => {
      for (const pr of p.prims) if (pr.k === 'text' && pr.text.toLowerCase().includes(q)) found.push({ page: pi, x: pr.x, y: pr.y, w: pr.w, h: pr.h });
    });
    lastQuery = q;
    matches.value = found;
    matchIdx.value = 0;
    if (!found.length) notify(`No matches for "${query.value}"`);
  } else {
    matchIdx.value = (matchIdx.value + dir + matches.value.length) % matches.value.length;
  }
  const m = matches.value[matchIdx.value];
  if (m) goto(m.page + 1, m.y);
}

async function doExport(kind: 'pdf' | 'xlsx' | 'csv' | 'html' | 'png') {
  exportOpen.value = false;
  if (!doc.value) return;
  const ex = await import('../export');
  const base = ex.safeFileName(state.report.name);
  busy.value = true;
  busyText.value = `Exporting ${kind.toUpperCase()}…`;
  try {
    await new Promise((r) => setTimeout(r, 20));
    if (kind === 'pdf') ex.downloadBlob(await ex.exportPdf(doc.value, state.report.name, (n) => (busyText.value = `Exporting PDF… page ${n}/${pageCount.value}`)), base + '.pdf');
    else if (kind === 'xlsx') ex.downloadBlob(ex.exportXlsx(doc.value, state.report.name), base + '.xlsx');
    else if (kind === 'csv') ex.downloadBlob(ex.exportCsv(doc.value), base + '.csv');
    else if (kind === 'html') ex.downloadBlob(new Blob([ex.exportHtml(doc.value, state.report.name)], { type: 'text/html' }), base + '.html');
    else {
      const r = await ex.exportPng(doc.value, base);
      ex.downloadBlob(r.blob, r.name);
    }
    notify('Export complete', 'success');
  } catch (e) {
    notify('Export failed: ' + (e as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}
async function doPrint() {
  if (!doc.value) return;
  const ex = await import('../export');
  ex.printDoc(doc.value, state.report.name);
}

function paramInput(name: string, v: unknown) {
  state.paramValues = { ...state.paramValues, [name]: v };
}
function paramValue(p: { name: string; defaultValue: string }) {
  return p.name in state.paramValues ? (state.paramValues[p.name] as any) : p.defaultValue;
}

/** for the Report Viewer: its host system can refresh, print and export */
defineExpose({ generate, print: doPrint, exportAs: doExport, pageCount });

onMounted(() => {
  measure();
  // 100% when the page fits, otherwise fit to width
  zoomMode.value = (viewW.value - 60) / state.report.page.width >= 1 ? 1 : 'width';
  new ResizeObserver(measure).observe(container.value!);
  if (visibleParams.value.length) showSide.value = 'params';
  void generate();
});
</script>

<template>
  <div class="preview">
    <div class="pv-toolbar">
      <button class="icon-btn" :class="{ active: showSide === 'params' }" title="Parameters" :disabled="!visibleParams.length" @click="showSide = showSide === 'params' ? null : 'params'">
        <SlidersHorizontal :size="16" />
      </button>
      <button class="icon-btn" :class="{ active: showSide === 'map' }" title="Document map" :disabled="!doc?.bookmarks.length" @click="showSide = showSide === 'map' ? null : 'map'">
        <BookOpen :size="16" />
      </button>
      <span class="sep" />
      <button class="icon-btn" title="First page" :disabled="currentPage <= 1" @click="goto(1)"><ChevronFirst :size="16" /></button>
      <button class="icon-btn" title="Previous page" :disabled="currentPage <= 1" @click="goto(currentPage - 1)"><ChevronLeft :size="16" /></button>
      <input class="pageno" :value="currentPage" @change="goto(Number(($event.target as HTMLInputElement).value))" />
      <span class="muted">of {{ pageCount }}</span>
      <button class="icon-btn" title="Next page" :disabled="currentPage >= pageCount" @click="goto(currentPage + 1)"><ChevronRight :size="16" /></button>
      <button class="icon-btn" title="Last page" :disabled="currentPage >= pageCount" @click="goto(pageCount)"><ChevronLast :size="16" /></button>
      <span class="sep" />
      <button class="icon-btn" title="Zoom out" @click="setZoom(scale - 0.1)"><ZoomOut :size="16" /></button>
      <select style="height: 26px" :value="typeof zoomMode === 'number' ? String(zoomMode) : zoomMode" @change="onZoomSelect(($event.target as HTMLSelectElement).value)">
        <option value="width">Page width</option>
        <option value="page">Whole page</option>
        <option v-for="z in [0.5, 0.75, 1, 1.25, 1.5, 2, 3]" :key="z" :value="String(z)">{{ z * 100 }}%</option>
        <option v-if="typeof zoomMode === 'number' && ![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(zoomMode)" :value="String(zoomMode)">{{ Math.round(zoomMode * 100) }}%</option>
      </select>
      <button class="icon-btn" title="Zoom in" @click="setZoom(scale + 0.1)"><ZoomIn :size="16" /></button>
      <span class="sep" />
      <div class="row" style="gap: 2px">
        <Search :size="14" class="muted" />
        <input v-model="query" placeholder="Find text…" style="width: 150px; height: 26px" @keydown.enter="runSearch($event.shiftKey ? -1 : 1)" @input="matches = []" />
        <span v-if="matches.length" class="muted" style="font-size: 12px">{{ matchIdx + 1 }}/{{ matches.length }}</span>
        <button class="icon-btn" title="Previous match" :disabled="!query" @click="runSearch(-1)"><ChevronLeft :size="14" /></button>
        <button class="icon-btn" title="Next match" :disabled="!query" @click="runSearch(1)"><ChevronRight :size="14" /></button>
      </div>
      <span class="grow" />
      <button class="btn" title="Reload the data (re-run database queries) and regenerate" @click="generate(true)"><RefreshCw :size="14" /> Refresh</button>
      <button class="btn" :disabled="!doc" @click="doPrint"><Printer :size="14" /> Print</button>
      <div class="dropdown" @mouseleave="exportOpen = false">
        <button class="btn primary" :disabled="!doc" @click="exportOpen = !exportOpen"><Download :size="14" /> Export <ChevronDown :size="12" /></button>
        <div v-if="exportOpen" class="dropdown-menu" style="left: auto; right: 0">
          <button class="menu-item" @click="doExport('pdf')"><FileText :size="15" /> PDF document (.pdf)</button>
          <button class="menu-item" @click="doExport('xlsx')"><FileSpreadsheet :size="15" /> Excel workbook (.xlsx)</button>
          <button class="menu-item" @click="doExport('csv')"><FileSpreadsheet :size="15" /> CSV file (.csv)</button>
          <button class="menu-item" @click="doExport('html')"><FileCode :size="15" /> Web page (.html)</button>
          <button class="menu-item" @click="doExport('png')"><FileImage :size="15" /> Image (.png / zip)</button>
        </div>
      </div>
    </div>
    <div v-if="error" class="warn-bar" style="background: #fee2e2; color: #991b1b">Error: {{ error }}</div>
    <div v-for="w in doc?.warnings ?? []" :key="w" class="warn-bar">{{ w }}</div>
    <template v-for="ds in state.report.dataSources" :key="ds.id">
      <div v-if="dataErrors[ds.id]" class="warn-bar" style="background: #fee2e2; color: #991b1b">Data source "{{ ds.name }}": {{ dataErrors[ds.id] }}</div>
    </template>

    <div class="pv-body" style="position: relative">
      <aside v-if="showSide" class="pv-side">
        <template v-if="showSide === 'params'">
          <div class="panel-title">Parameters</div>
          <form class="param-form" @submit.prevent="generate()">
            <label v-for="p in visibleParams" :key="p.id">
              {{ p.label || p.name }}
              <select v-if="p.values" :value="String(paramValue(p))" @change="paramInput(p.name, ($event.target as HTMLSelectElement).value)">
                <option v-for="v in p.values.split(',').map((s) => s.trim())" :key="v" :value="v">{{ v }}</option>
              </select>
              <input v-else-if="p.type === 'boolean'" type="checkbox" :checked="String(paramValue(p)) === 'true'" @change="paramInput(p.name, ($event.target as HTMLInputElement).checked)" />
              <input
                v-else
                :type="p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text'"
                :value="String(paramValue(p) ?? '')"
                @change="paramInput(p.name, ($event.target as HTMLInputElement).value)"
              />
            </label>
            <div class="row">
              <button class="btn primary" type="submit">Submit</button>
              <button class="btn" type="button" @click="state.paramValues = {}; generate()">Reset</button>
            </div>
          </form>
        </template>
        <template v-else>
          <div class="panel-title">Document Map</div>
          <div v-for="(b, i) in doc?.bookmarks ?? []" :key="i" class="docmap-item" :style="{ paddingLeft: 10 + b.level * 14 + 'px' }" :title="b.text" @click="goto(b.page + 1, b.y)">
            {{ b.text }}
          </div>
        </template>
      </aside>

      <div ref="container" class="pv-pages" @scroll="onScroll">
        <template v-if="doc">
          <div v-for="(p, i) in doc.pages" :key="i" class="pv-page" :style="{ width: p.width * scale + 'px', height: p.height * scale + 'px' }">
            <div v-if="inRange(i)" style="width: 100%; height: 100%" v-html="svgOf(i)" />
            <span class="pno">Page {{ i + 1 }} / {{ doc.pages.length }}</span>
          </div>
        </template>
      </div>
      <div v-if="busy" class="pv-busy"><div class="spinner" /> {{ busyText }}</div>
    </div>
    <div class="statusbar">
      <span v-if="doc">{{ doc.pages.length }} page(s)</span>
      <span v-if="doc">rendered in {{ Math.round(doc.timeMs) }} ms</span>
      <span>{{ state.report.name }}</span>
      <span class="zoom">Zoom {{ Math.round(scale * 100) }}%</span>
    </div>
  </div>
</template>
