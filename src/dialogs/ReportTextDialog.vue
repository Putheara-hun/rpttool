<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Braces, Check, ClipboardCopy, ClipboardPaste, FileCode2, Globe } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { buildText, closeDialog, loadReport, notify, openDialog, parseReportText, SAVE_FORMATS, state, type SaveFormat } from '../store/designer';

/**
 * The report as text, for systems that store reports themselves:
 *  - Copy: the finished design as XML (RDL) / HTML / JSON text -> the user pastes it into their own system
 *  - Open: paste such a text back in to keep editing
 */
const tab = ref<'copy' | 'open'>(state.dialogProps?.tab === 'open' ? 'open' : 'copy');

const FORMATS: { id: SaveFormat; label: string; icon: any; note: string }[] = [
  { id: 'rdl', label: 'XML (RDL)', icon: FileCode2, note: 'Report definition XML. Opens in SQL Server Reporting Services / Report Builder, and again here to edit.' },
  { id: 'html', label: 'HTML', icon: Globe, note: 'The finished report page with the current data. Shows and prints in any browser, and opens again here to edit.' },
  { id: 'rptx', label: 'JSON', icon: Braces, note: 'The ReportTool design only (smallest). Opens again here to edit.' },
];
const LAST_KEY = 'reporttool.copyFormat';
function lastFormat(): SaveFormat {
  try {
    const v = localStorage.getItem(LAST_KEY) as SaveFormat | null;
    if (v && FORMATS.some((f) => f.id === v)) return v;
  } catch {
    /* storage blocked */
  }
  return 'rdl';
}

// ---------------------------------------------------------------- copy
const format = ref<SaveFormat>(lastFormat());
const text = ref('');
const extra = ref<{ name: string; text: string }[]>([]);
const warnings = ref<string[]>([]);
const building = ref(false);
const error = ref('');
const copied = ref('');
const out = ref<HTMLTextAreaElement>();
let job = 0;

async function build() {
  const my = ++job;
  building.value = true;
  error.value = '';
  copied.value = '';
  try {
    const r = await buildText(format.value);
    if (my !== job) return;
    text.value = r.text;
    extra.value = r.extra;
    warnings.value = r.warnings;
  } catch (e) {
    if (my !== job) return;
    text.value = '';
    extra.value = [];
    error.value = (e as Error).message;
  } finally {
    if (my === job) building.value = false;
  }
}
watch(format, (f) => {
  try {
    localStorage.setItem(LAST_KEY, f);
  } catch {
    /* storage blocked */
  }
  void build();
});
onMounted(() => {
  if (tab.value === 'copy') void build();
});
watch(tab, (t) => {
  if (t === 'copy' && !text.value && !building.value) void build();
});

const size = computed(() => {
  const b = new Blob([text.value]).size;
  return b < 1024 ? `${b} bytes` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;
});
const formatLabel = (f: SaveFormat) => FORMATS.find((x) => x.id === f)!.label;

async function writeClipboard(t: string, area?: HTMLTextAreaElement | null) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    // older browsers / blocked permission: copy the selected text of the box
    if (!area) return false;
    area.focus();
    area.select();
    return document.execCommand('copy');
  }
}
async function copyMain() {
  if (!text.value) return;
  if (await writeClipboard(text.value, out.value)) {
    copied.value = 'main';
    // the copy is how the report is saved: the design no longer counts as "unsaved"
    state.dirty = false;
    notify(`Report copied as ${formatLabel(format.value)} text (${size.value}) — paste it into your system`, 'success');
  } else notify('Copy failed: select the text in the box and press Ctrl+C', 'error');
}
async function copyExtra(i: number) {
  if (await writeClipboard(extra.value[i].text)) {
    copied.value = 'extra' + i;
    notify(`Copied ${extra.value[i].name}`, 'success');
  }
}

// ---------------------------------------------------------------- open
const pasted = ref('');
const opening = ref(false);
const openError = ref('');
const detected = computed(() => {
  const t = pasted.value.replace(/^﻿/, '').trimStart();
  if (!t) return '';
  if (/^(<\?xml|<Report\b)/.test(t)) return 'XML (RDL)';
  if (/^(<!doctype html|<html\b)/i.test(t)) return 'HTML';
  if (t.startsWith('{')) return 'JSON';
  return 'unknown';
});
async function pasteFromClipboard() {
  openError.value = '';
  try {
    pasted.value = await navigator.clipboard.readText();
  } catch {
    openError.value = 'The browser did not allow reading the clipboard: click in the box and press Ctrl+V.';
  }
}
async function openText() {
  if (!pasted.value.trim()) return;
  opening.value = true;
  openError.value = '';
  try {
    const hint: SaveFormat | undefined = detected.value === 'XML (RDL)' ? 'rdl' : detected.value === 'HTML' ? 'html' : detected.value === 'JSON' ? 'rptx' : undefined;
    // read the text first: a text that is not a report must not cost the current design
    const { def, warnings: w } = await parseReportText(pasted.value, 'pasted report', hint);
    if (state.dirty && !confirm('Discard unsaved changes and open the pasted report?')) return;
    const ext = SAVE_FORMATS[hint ?? 'rptx'].ext;
    (state as any)._handle = null;
    loadReport(def, (def.name || 'report') + ext);
    notify(`Opened "${def.name || 'report'}" from text`, 'success');
    if (w.length) openDialog('saveInfo', { title: 'Imported RDL report', note: 'The RDL report was converted into a ReportTool design. Check these points:', files: [], warnings: w });
    else closeDialog();
  } catch (e) {
    openError.value = 'This text is not a report: ' + (e as Error).message;
  } finally {
    opening.value = false;
  }
}
</script>

<template>
  <Modal title="Report as Text" :width="760" @close="closeDialog">
    <template #icon><ClipboardCopy :size="16" /></template>
    <div class="rt-tabs">
      <button :class="{ on: tab === 'copy' }" @click="tab = 'copy'"><ClipboardCopy :size="14" /> Copy text</button>
      <button :class="{ on: tab === 'open' }" @click="tab = 'open'"><ClipboardPaste :size="14" /> Open from text</button>
    </div>

    <template v-if="tab === 'copy'">
      <p class="rt-lead">Copy the finished report and paste it into your own system (for example a text column in its database). Paste it back in <b>Open from text</b> to edit it later.</p>
      <div class="rt-formats">
        <button v-for="f in FORMATS" :key="f.id" class="rt-format" :class="{ on: format === f.id }" @click="format = f.id">
          <component :is="f.icon" :size="16" />
          <span class="rt-format-label">{{ f.label }}</span>
          <span class="rt-format-note">{{ f.note }}</span>
        </button>
      </div>
      <div class="rt-box-head">
        <span>{{ building ? 'Building…' : error ? '' : `${formatLabel(format)} · ${size}` }}</span>
      </div>
      <textarea ref="out" class="rt-text" readonly spellcheck="false" :value="building ? '' : text" :placeholder="building ? 'Building the report text…' : ''" />
      <div v-if="error" class="err" style="margin-top: 6px">Could not build the text: {{ error }}</div>
      <template v-if="extra.length && !building">
        <div class="section-title">Subreports ({{ extra.length }}) — only needed for SQL Server Reporting Services</div>
        <p class="hint" style="margin: 0 0 6px">ReportTool reopens the main text on its own. To publish to a Report Server, store these next to the main report under these names.</p>
        <div v-for="(x, i) in extra" :key="x.name" class="rt-extra">
          <code>{{ x.name }}</code>
          <button class="btn small" @click="copyExtra(i)"><component :is="copied === 'extra' + i ? Check : ClipboardCopy" :size="13" /> {{ copied === 'extra' + i ? 'Copied' : 'Copy' }}</button>
        </div>
      </template>
      <details v-if="warnings.length && !building" class="rt-warnings">
        <summary>Conversion notes ({{ warnings.length }})</summary>
        <ul class="save-warnings">
          <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
        </ul>
      </details>
    </template>

    <template v-else>
      <p class="rt-lead">Paste a report text that was copied from ReportTool (XML / RDL, HTML or JSON). RDL from Report Builder / SSRS works too.</p>
      <textarea v-model="pasted" class="rt-text" spellcheck="false" placeholder="Paste the report text here (Ctrl+V)" @input="openError = ''" />
      <div class="rt-box-head" style="margin-top: 6px">
        <span v-if="detected && detected !== 'unknown'">Detected: {{ detected }}</span>
        <span v-else-if="detected === 'unknown'" class="err">Not recognised — the text should start with &lt;?xml, &lt;Report, &lt;!doctype html or {</span>
      </div>
      <div v-if="openError" class="err" style="margin-top: 6px">{{ openError }}</div>
    </template>

    <template #footer>
      <template v-if="tab === 'copy'">
        <span class="grow" />
        <button class="btn" @click="closeDialog">Close</button>
        <button class="btn primary" :disabled="building || !text" @click="copyMain">
          <component :is="copied === 'main' ? Check : ClipboardCopy" :size="14" /> {{ copied === 'main' ? 'Copied' : 'Copy to clipboard' }}
        </button>
      </template>
      <template v-else>
        <button class="btn" @click="pasteFromClipboard"><ClipboardPaste :size="14" /> Paste</button>
        <span class="grow" />
        <button class="btn" @click="closeDialog">Cancel</button>
        <button class="btn primary" :disabled="opening || !pasted.trim() || detected === 'unknown'" @click="openText">{{ opening ? 'Opening…' : 'Open report' }}</button>
      </template>
    </template>
  </Modal>
</template>
