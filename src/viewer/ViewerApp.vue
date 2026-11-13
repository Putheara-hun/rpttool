<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { FileText, FolderOpen, X } from 'lucide-vue-next';
import PreviewPanel from '../preview/PreviewPanel.vue';
import LoginDialog from '../dialogs/LoginDialog.vue';
import SiteLoginDialog from '../dialogs/SiteLoginDialog.vue';
import type { Row } from '../model/types';
import { invalidateData, loadReport, state } from '../store/designer';
import { applyData, declareParams, paramValuesFor, prepareReport, type OpenOptions } from './load';
import { initViewerHost, notifyHost, setController, viewerHost, type ExportFormat } from './host';

/**
 * Report Viewer: shows a report from its text (HTML / XML-RDL / JSON copied from the designer, or an RDL file)
 * with the designer's preview — pages, zoom, find, parameters, print and export — and nothing to edit.
 */
const preview = ref<InstanceType<typeof PreviewPanel>>();
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
  viewKey.value++; // a fresh preview renders the new report
  await nextTick();
  return { name: def.name, warnings };
}
function requireReport() {
  if (!loaded.value) throw new Error('Load a report first.');
}
async function regenerate(reloadData = false) {
  await nextTick();
  await preview.value?.generate(reloadData);
}

setController({
  open,
  async setData(name: string, rows: Row[]) {
    requireReport();
    for (const id of applyData(state.report, { [name]: rows })) invalidateData(id);
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
    await preview.value?.print();
  },
  async exportAs(format: ExportFormat) {
    requireReport();
    await preview.value?.exportAs(format);
  },
});

// ---- standalone use: paste the text or open a file
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
  <div class="app viewer-app">
    <div class="titlebar">
      <div class="logo"><FileText :size="18" /> Report Viewer</div>
      <div class="doc-title">{{ loaded ? state.report.name || 'Report' : '' }}</div>
      <button v-if="loaded && !viewerHost.active" class="btn small viewer-open" @click="openAnother"><FolderOpen :size="14" /> Open another report</button>
    </div>

    <div v-for="(w, i) in importWarnings" :key="i" class="warn-bar viewer-warn">
      <span>{{ w }}</span>
      <button class="icon-btn" title="Hide" @click="importWarnings.splice(i, 1)"><X :size="13" /></button>
    </div>

    <div class="main">
      <section class="center">
        <PreviewPanel
          v-if="loaded"
          ref="preview"
          :key="viewKey"
          @rendered="(pages) => notifyHost('rendered', { pages })"
          @failed="(message) => notifyHost('error', { message })"
        />
        <div v-else-if="viewerHost.active" class="vw-wait"><div class="spinner" /> Waiting for the report…</div>
        <div v-else class="vw-start" @dragover.prevent @drop.prevent="openFile(($event as DragEvent).dataTransfer?.files?.[0])">
          <div class="vw-card">
            <h1><FileText :size="22" /> Report Viewer</h1>
            <p>Paste the text of a report — XML (RDL), HTML or JSON, as copied with <b>Copy Text</b> in the designer — or open a report file. You can also drop a file here.</p>
            <textarea v-model="pasted" spellcheck="false" placeholder="Paste the report text here (Ctrl+V)" @input="openError = ''" />
            <div v-if="openError" class="err">{{ openError }}</div>
            <div class="row" style="margin-top: 10px">
              <button class="btn" :disabled="opening" @click="pickFile"><FolderOpen :size="14" /> Open file…</button>
              <span class="grow" />
              <button class="btn primary" :disabled="opening || !pasted.trim()" @click="openPasted">{{ opening ? 'Opening…' : 'Show report' }}</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <LoginDialog v-if="state.loginRequests.length" :key="state.loginRequests[0].connectionId" />
    <SiteLoginDialog v-if="state.siteLogin" />
    <div class="toasts">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>
