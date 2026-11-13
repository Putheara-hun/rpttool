<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ensureReportFonts } from './engine/fonts';
import { embed, FORMAT_LABEL, initEmbed, saveToHost } from './embed/bridge';

// ?embed=1: running inside another system's iframe
initEmbed();
import {
  Boxes,
  ChevronDown,
  ClipboardCopy,
  ClipboardPaste,
  Database,
  Eye,
  FileCode2,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  History,
  ListTree,
  PencilRuler,
  Redo2,
  Save,
  SaveAll,
  SlidersHorizontal,
  Undo2,
} from 'lucide-vue-next';
import Ribbon from './designer/Ribbon.vue';
import Toolbox from './designer/Toolbox.vue';
import FieldList from './designer/FieldList.vue';
import ReportExplorer from './designer/ReportExplorer.vue';
import PropertyGrid from './designer/PropertyGrid.vue';
import DesignSurface from './designer/DesignSurface.vue';
import PreviewPanel from './preview/PreviewPanel.vue';
import DialogHost from './dialogs/DialogHost.vue';
import ExpressionEditor from './dialogs/ExpressionEditor.vue';
import LoginDialog from './dialogs/LoginDialog.vue';
import SiteLoginDialog from './dialogs/SiteLoginDialog.vue';
import ReconnectDialog from './dialogs/ReconnectDialog.vue';
import ContextMenu from './components/ContextMenu.vue';
import {
  clearSelection,
  deleteSelection,
  discardPreviousSession,
  duplicateSelection,
  history,
  newReportCmd,
  nudge,
  openDialog,
  pickReportFile,
  redo,
  restorePreviousSession,
  saveReport,
  saveReportAs,
  selectAll,
  selectedElements,
  stashPreviousSession,
  state,
  undo,
} from './store/designer';
import { closeContextMenu, openContextMenu } from './designer/ui';

/** Save ▾ menu: other file formats */
function saveMenu(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu({ clientX: r.left - 28, clientY: r.bottom + 2, preventDefault() {} } as MouseEvent, [
    { label: 'Save', icon: Save, kbd: 'Ctrl+S', action: () => saveReport() },
    { label: 'Save As… (ReportTool .rptx)', icon: SaveAll, action: () => saveReportAs('rptx') },
    { sep: true },
    { label: 'Save as HTML… (report + design)', icon: Globe, action: () => saveReportAs('html') },
    { label: 'Save as RDL… (SQL Server Reporting Services)', icon: FileCode2, action: () => saveReportAs('rdl') },
    { sep: true },
    { label: 'Copy as Text… (XML / HTML / JSON)', icon: ClipboardCopy, action: copyAsText },
    { label: 'Open from Text… (paste)', icon: ClipboardPaste, action: openFromText },
    { sep: true },
    { label: 'Open… (.rptx, .html, .rdl)', icon: FolderOpen, kbd: 'Ctrl+O', action: pickReportFile },
  ]);
}
/** the report as text for the user's own system, and back */
const copyAsText = () => openDialog('reportText', { tab: 'copy' });
const openFromText = () => openDialog('reportText', { tab: 'open' });
import { pageSizeText } from './model/defaults';

const previous = ref<{ name: string; count: number } | null>(null);
function restorePrevious() {
  restorePreviousSession();
  previous.value = null;
}
function dismissPrevious() {
  discardPreviousSession();
  previous.value = null;
}
const pageText = computed(() => pageSizeText(state.report.page) + (state.report.page.autoWidth ? ' · auto width' : ''));

const title = computed(() =>
  embed.active ? `${embed.title || state.report.name || 'Report'}${state.dirty ? ' •' : ''}` : `${state.report.name || 'Report'} — ${state.fileName}${state.dirty ? ' •' : ''}`,
);
const statusText = computed(() => {
  const els = selectedElements.value;
  if (els.length === 1) {
    const e = els[0];
    return `${e.name}  ·  X ${e.x}  Y ${e.y}  W ${e.width}  H ${e.height}`;
  }
  if (els.length > 1) return `${els.length} controls selected`;
  if (state.selectedBandId) return 'Band selected';
  return `${state.report.elements.length} controls · ${state.report.bands.length} bands`;
});

function onKey(e: KeyboardEvent) {
  if (state.dialog || state.exprRequest || state.loginRequests.length || state.siteLogin || state.reconnectRequests.length) return;
  const t = e.target as HTMLElement;
  // only text-entry controls swallow shortcuts (checkboxes, radios, sliders, buttons do not)
  if (t instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'color', 'button'].includes(t.type)) return;
  if (t && t.closest && t.closest('textarea, select, [contenteditable="true"]')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 's') {
    e.preventDefault();
    if (embed.active) void saveToHost();
    else saveReport(e.shiftKey);
    return;
  }
  if (ctrl && k === 'o') {
    e.preventDefault();
    if (!embed.active) pickReportFile();
    return;
  }
  if (ctrl && k === 'n' && e.altKey) {
    e.preventDefault();
    if (!embed.active) newReportCmd();
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    state.mode = state.mode === 'design' ? 'preview' : 'design';
    return;
  }
  if (state.mode !== 'design') return;
  if (ctrl && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (ctrl && k === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  // Ctrl+C / Ctrl+X / Ctrl+V are handled by the copy / cut / paste events in DesignSurface (system clipboard)
  if (ctrl && k === 'd') {
    e.preventDefault();
    duplicateSelection();
    return;
  }
  if (ctrl && k === 'a') {
    e.preventDefault();
    selectAll();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (e.key === 'Escape') {
    if (state.formatBrush) {
      state.formatBrush = null;
      return;
    }
    state.tool = null;
    clearSelection();
    closeContextMenu();
    return;
  }
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && selectedElements.value.length) {
    e.preventDefault();
    const step = ctrl ? state.gridSize : 1;
    const [dx, dy] = arrows[e.key];
    nudge(dx * step, dy * step, e.shiftKey);
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (state.dirty && !embed.active) e.preventDefault();
}

// Google fonts used by the report are downloaded when the report opens or a control starts using one
watch(
  () => state.revision,
  () => void ensureReportFonts(state.report),
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('mousedown', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
  // always start with a blank page; offer to bring back unsaved work from the last session
  // (not when embedded: the host system loads its report)
  previous.value = embed.active ? null : stashPreviousSession();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('mousedown', closeContextMenu);
  window.removeEventListener('blur', closeContextMenu);
});
</script>

<template>
  <div class="app">
    <div class="titlebar">
      <div class="logo"><FileText :size="18" /> ReportTool</div>
      <template v-if="!embed.active">
        <button class="icon-btn" title="New report (Ctrl+Alt+N)" @click="newReportCmd"><FilePlus :size="16" /></button>
        <button class="icon-btn" title="Open (Ctrl+O)" @click="pickReportFile"><FolderOpen :size="16" /></button>
        <button class="icon-btn" title="Open from text (paste a copied report)" @click="openFromText"><ClipboardPaste :size="16" /></button>
        <button class="icon-btn" title="Save (Ctrl+S)" @click="saveReport()"><Save :size="16" /></button>
        <button class="icon-btn save-caret" title="Save as HTML / RDL…" @click="saveMenu"><ChevronDown :size="13" /></button>
      </template>
      <button class="icon-btn" title="Undo (Ctrl+Z)" :disabled="!history.canUndo" @click="undo"><Undo2 :size="16" /></button>
      <button class="icon-btn" title="Redo (Ctrl+Y)" :disabled="!history.canRedo" @click="redo"><Redo2 :size="16" /></button>
      <div class="doc-title">{{ title }}</div>
      <!-- embedded in another system: Save hands the report to it as text -->
      <div v-if="embed.active" class="embed-save">
        <select v-if="embed.formats.length > 1" v-model="embed.format" title="Format of the saved report">
          <option v-for="f in embed.formats" :key="f" :value="f">{{ FORMAT_LABEL[f] }}</option>
        </select>
        <button class="btn small primary" :disabled="embed.saving" title="Save (Ctrl+S)" @click="saveToHost()"><Save :size="14" /> {{ embed.saving ? 'Saving…' : embed.saveLabel }}</button>
      </div>
      <!-- finished design -> text the user pastes into their own system -->
      <div v-else class="embed-save">
        <button class="btn small primary copy-text-btn" title="Copy the report as XML / HTML / JSON text to paste into your system" @click="copyAsText">
          <ClipboardCopy :size="14" /> Copy Text
        </button>
      </div>
      <div class="mode-switch">
        <button :class="{ on: state.mode === 'design' }" @click="state.mode = 'design'"><PencilRuler :size="14" /> Designer</button>
        <button :class="{ on: state.mode === 'preview' }" title="Preview (F5)" @click="state.mode = 'preview'"><Eye :size="14" /> Preview</button>
      </div>
    </div>

    <Ribbon v-if="state.mode === 'design'" />
    <div v-if="previous && state.mode === 'design'" class="restore-bar">
      <History :size="15" />
      <span>Unsaved report from your last session found: <b>{{ previous.name }}</b> ({{ previous.count }} controls).</span>
      <button class="btn small primary" @click="restorePrevious">Restore it</button>
      <button class="btn small" @click="dismissPrevious">Discard</button>
    </div>

    <div class="main">
      <aside v-show="state.mode === 'design'" class="side left">
        <div class="side-tabs">
          <button :class="{ on: state.leftTab === 'toolbox' }" @click="state.leftTab = 'toolbox'"><Boxes :size="14" /> Toolbox</button>
          <button :class="{ on: state.leftTab === 'fields' }" @click="state.leftTab = 'fields'"><Database :size="14" /> Field List</button>
        </div>
        <div class="side-body">
          <Toolbox v-if="state.leftTab === 'toolbox'" />
          <FieldList v-else />
        </div>
      </aside>

      <section class="center">
        <template v-if="state.mode === 'design'">
          <DesignSurface />
          <div class="statusbar">
            <span>{{ statusText }}</span>
            <span class="page-size-chip" title="Paper size — change it in Home ▸ Page or Page Setup">{{ pageText }}</span>
            <span v-if="state.tool" style="color: var(--accent)">Tool: {{ state.tool }} — click inside a band (Esc to cancel)</span>
            <span class="zoom">
              <button class="icon-btn" style="width: 20px; height: 20px" title="Zoom out" @click="state.zoom = Math.max(0.25, Math.round((state.zoom - 0.1) * 100) / 100)">−</button>
              <input v-model.number="state.zoom" type="range" min="0.25" max="3" step="0.05" />
              <button class="icon-btn" style="width: 20px; height: 20px" title="Zoom in" @click="state.zoom = Math.min(4, Math.round((state.zoom + 0.1) * 100) / 100)">+</button>
              <span style="width: 40px; text-align: right; cursor: pointer" title="Reset to 100%" @click="state.zoom = 1">{{ Math.round(state.zoom * 100) }}%</span>
            </span>
          </div>
        </template>
        <PreviewPanel v-else />
      </section>

      <aside v-show="state.mode === 'design'" class="side right">
        <div class="side-tabs">
          <button :class="{ on: state.rightTab === 'properties' }" @click="state.rightTab = 'properties'"><SlidersHorizontal :size="14" /> Properties</button>
          <button :class="{ on: state.rightTab === 'explorer' }" @click="state.rightTab = 'explorer'"><ListTree :size="14" /> Report Explorer</button>
        </div>
        <div class="side-body">
          <PropertyGrid v-if="state.rightTab === 'properties'" />
          <ReportExplorer v-else />
        </div>
      </aside>
    </div>

    <DialogHost />
    <ExpressionEditor v-if="state.exprRequest" />
    <LoginDialog v-if="state.loginRequests.length" :key="state.loginRequests[0].connectionId" />
    <ReconnectDialog />
    <SiteLoginDialog v-if="state.siteLogin" />
    <ContextMenu />
    <div class="toasts">
      <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </div>
</template>
