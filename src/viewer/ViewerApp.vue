<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import SheetViewer from './SheetViewer.vue';
import LoginDialog from '../dialogs/LoginDialog.vue';
import SiteLoginDialog from '../dialogs/SiteLoginDialog.vue';
import type { Row } from '../model/types';
import { invalidateData, loadReport, state } from '../store/designer';
import { applyData, declareParams, paramValuesFor, prepareReport, type OpenOptions } from './load';
import { initViewerHost, notifyHost, setController, viewerHost, type ExportFormat } from './host';
import { labels as L } from './labels';

/**
 * Report Viewer: shows a report from its text (HTML / XML-RDL / JSON copied from the designer, or an RDL file).
 * Made to sit in an iframe of another application, which runs its query and sends the text + rows (viewer.js);
 * opened by hand it offers a paste box.
 */
const viewer = ref<InstanceType<typeof SheetViewer>>();
const loaded = ref(false);
const viewKey = ref(0);
const importWarnings = ref<string[]>([]);
const pasted = ref('');
const openError = ref('');
const opening = ref(false);

const fileBase = (s: string) => (s || 'report').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'report';

async function open(text: string, o: OpenOptions = {}) {
  const { def, warnings } = await prepareReport(text, o);
  loadReport(def, fileBase(def.name) + '.rptx');
  state.paramValues = paramValuesFor(def, o.params);
  importWarnings.value = warnings;
  loaded.value = true;
  viewKey.value++; // a fresh viewer renders the new report
  await nextTick();
  return { name: def.name, warnings };
}
function requireReport() {
  if (!loaded.value) throw new Error('Load a report first.');
}
async function regenerate(reloadData = false) {
  await nextTick();
  await viewer.value?.generate(reloadData);
}

setController({
  open,
  async setData(name: string | null, rows: Row[]) {
    requireReport();
    // no name: the report's main data source
    for (const id of applyData(state.report, name ? { [name]: rows } : rows)) invalidateData(id);
    await regenerate();
  },
  async setParams(values: Record<string, unknown>, refresh: boolean) {
    requireReport();
    declareParams(state.report, Object.keys(values));
    state.paramValues = { ...state.paramValues, ...paramValuesFor(state.report, values) };
    if (refresh) await regenerate();
  },
  async refresh(reloadData: boolean) {
    requireReport();
    await regenerate(reloadData);
  },
  async print() {
    requireReport();
    await viewer.value?.print();
  },
  async exportAs(format: ExportFormat) {
    requireReport();
    await viewer.value?.exportAs(format);
  },
});

// ---- opened by hand: paste the text or open a file
async function openPasted() {
  if (!pasted.value.trim()) return;
  opening.value = true;
  openError.value = '';
  try {
    await open(pasted.value);
    pasted.value = '';
  } catch (e) {
    openError.value = (e as Error).message;
  } finally {
    opening.value = false;
  }
}
async function openFile(f: File | undefined) {
  if (!f) return;
  opening.value = true;
  openError.value = '';
  try {
    const ext = f.name.toLowerCase().split('.').pop() ?? '';
    await open(await f.text(), { format: ['rdl', 'rdlc', 'xml'].includes(ext) ? 'xml' : ['html', 'htm'].includes(ext) ? 'html' : undefined });
  } catch (e) {
    openError.value = `"${f.name}" could not be opened: ${(e as Error).message}`;
  } finally {
    opening.value = false;
  }
}
function pickFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.rdl,.rdlc,.xml,.html,.htm,.rptx,.json';
  inp.onchange = () => void openFile(inp.files?.[0]);
  inp.click();
}
function openAnother() {
  loaded.value = false;
  importWarnings.value = [];
}

onMounted(() => {
  initViewerHost();
});
</script>

<template>
  <div class="rv-app">
    <div v-for="(w, i) in importWarnings" :key="i" class="vw-warn">
      <span>{{ w }}</span>
      <button class="vw-x" title="Hide" @click="importWarnings.splice(i, 1)">✕</button>
    </div>

    <SheetViewer
      v-if="loaded"
      ref="viewer"
      :key="viewKey"
      @rendered="(pages) => notifyHost('rendered', { pages })"
      @failed="(message) => notifyHost('error', { message })"
      @refresh="notifyHost('refresh')"
    >
      <template v-if="!viewerHost.active" #actions>
        <button class="vw-btn small" @click="openAnother">Open another report</button>
      </template>
    </SheetViewer>

    <div v-else-if="viewerHost.active" class="vw-wait"><span class="rv-spin" /> {{ L.rpt_waiting }}</div>

    <div v-else class="vw-start" @dragover.prevent @drop.prevent="openFile(($event as DragEvent).dataTransfer?.files?.[0])">
      <div class="vw-card">
        <h1>Report Viewer</h1>
        <p>Paste the text of a report — XML (RDL), HTML or JSON, as copied with <b>Copy Text</b> in the designer — or open a report file. You can also drop a file here.</p>
        <textarea v-model="pasted" spellcheck="false" placeholder="Paste the report text here (Ctrl+V)" @input="openError = ''" />
        <div v-if="openError" class="vw-err">{{ openError }}</div>
        <div class="vw-row">
          <button class="vw-btn" :disabled="opening" @click="pickFile">Open file…</button>
          <span class="vw-grow" />
          <button class="vw-btn primary" :disabled="opening || !pasted.trim()" @click="openPasted">{{ opening ? 'Opening…' : 'Show report' }}</button>
        </div>
      </div>
    </div>

    <LoginDialog v-if="state.loginRequests.length" :key="state.loginRequests[0].connectionId" />
    <SiteLoginDialog v-if="state.siteLogin" />
    <div class="toasts">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>
