<script setup lang="ts">
import { computed, ref } from 'vue';
import { FileBox } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { contentRight, MARGIN_PRESETS, mmToPx, PAPER_SIZES, pxToMm } from '../model/defaults';
import { closeDialog, mutate, state } from '../store/designer';

const p = state.report.page;
const r1 = (v: number) => Math.round(v * 10) / 10;
const paper = ref(p.paper);
const orientation = ref(p.orientation);
const w = ref(r1(pxToMm(p.baseWidth ?? p.width)));
const h = ref(r1(pxToMm(p.height)));
const m = ref({ top: r1(pxToMm(p.margins.top)), right: r1(pxToMm(p.margins.right)), bottom: r1(pxToMm(p.margins.bottom)), left: r1(pxToMm(p.margins.left)) });
const autoWidth = ref(!!p.autoWidth);
const autoHeight = ref(!!p.autoHeight);
const contentMm = r1(pxToMm(contentRight(state.report)));

function applyPaper() {
  const s = PAPER_SIZES[paper.value];
  if (!s) return;
  if (s.roll) {
    orientation.value = 'portrait';
    autoHeight.value = true;
    m.value = { top: 3, right: 3, bottom: 3, left: 3 };
  }
  w.value = orientation.value === 'portrait' || s.roll ? s.w : s.h;
  h.value = orientation.value === 'portrait' || s.roll ? s.h : s.w;
}
function setOrientation(o: 'portrait' | 'landscape') {
  if (o === orientation.value) return;
  orientation.value = o;
  [w.value, h.value] = [h.value, w.value];
}
function setMargins(k: string) {
  const v = MARGIN_PRESETS[k]?.mm;
  if (v !== undefined) m.value = { top: v, right: v, bottom: v, left: v };
}
function fitWidth() {
  paper.value = 'Custom';
  w.value = r1(Math.max(30, contentMm + m.value.left + m.value.right));
}
const preview = computed(() => {
  const sc = 160 / Math.max(w.value, h.value, 1);
  return { w: w.value * sc, h: h.value * sc, t: m.value.top * sc, r: m.value.right * sc, b: m.value.bottom * sc, l: m.value.left * sc };
});
function ok() {
  mutate((r) => {
    const pg = r.page;
    pg.paper = paper.value;
    pg.orientation = orientation.value;
    pg.baseWidth = mmToPx(Math.max(10, w.value));
    pg.width = pg.baseWidth;
    pg.height = mmToPx(Math.max(10, h.value));
    pg.margins = { top: mmToPx(m.value.top), right: mmToPx(m.value.right), bottom: mmToPx(m.value.bottom), left: mmToPx(m.value.left) };
    pg.autoWidth = autoWidth.value;
    pg.autoHeight = autoHeight.value;
  });
  closeDialog();
}
</script>

<template>
  <Modal title="Page Setup" :width="680" @close="closeDialog">
    <template #icon><FileBox :size="16" /></template>
    <div class="split">
      <div class="form-grid" style="flex: 1; align-content: start">
        <label>Paper size</label>
        <select v-model="paper" @change="applyPaper">
          <option v-for="(s, k) in PAPER_SIZES" :key="k" :value="k">{{ s.label }}</option>
          <option value="Custom">Custom size</option>
        </select>
        <label>Orientation</label>
        <div class="row">
          <label class="row"><input type="radio" :checked="orientation === 'portrait'" @change="setOrientation('portrait')" /> Portrait</label>
          <label class="row"><input type="radio" :checked="orientation === 'landscape'" @change="setOrientation('landscape')" /> Landscape</label>
        </div>
        <label>Width × Height (mm)</label>
        <div class="row">
          <input v-model.number="w" type="number" min="10" step="0.1" style="width: 86px" @input="paper = 'Custom'" /> ×
          <input v-model.number="h" type="number" min="10" step="0.1" style="width: 86px" :disabled="autoHeight" @input="paper = 'Custom'" />
          <button class="btn small" :disabled="!contentMm" :title="`Content is ${contentMm} mm wide`" @click="fitWidth">Fit width to content</button>
        </div>
        <label>Margins</label>
        <select :value="''" @change="setMargins(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>Choose a preset…</option>
          <option v-for="(mp, k) in MARGIN_PRESETS" :key="k" :value="k">{{ mp.label }}</option>
        </select>
        <label>Margins (mm)</label>
        <div class="row" style="flex-wrap: wrap">
          <span>Top</span><input v-model.number="m.top" type="number" min="0" step="0.5" style="width: 62px" />
          <span>Bottom</span><input v-model.number="m.bottom" type="number" min="0" step="0.5" style="width: 62px" />
        </div>
        <label />
        <div class="row" style="flex-wrap: wrap">
          <span>Left</span><input v-model.number="m.left" type="number" min="0" step="0.5" style="width: 62px" />
          <span>Right</span><input v-model.number="m.right" type="number" min="0" step="0.5" style="width: 62px" />
        </div>
        <label>Auto size</label>
        <div class="col" style="gap: 4px">
          <label class="row"><input v-model="autoWidth" type="checkbox" /> Auto width — page grows wider to fit controls and tables</label>
          <label class="row"><input v-model="autoHeight" type="checkbox" /> Auto height (roll paper) — one continuous page, height fits the content</label>
        </div>
      </div>
      <div style="width: 180px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px">
        <div :style="{ width: preview.w + 'px', height: preview.h + 'px', background: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,.2)', position: 'relative' }">
          <div :style="{ position: 'absolute', left: preview.l + 'px', top: preview.t + 'px', right: preview.r + 'px', bottom: preview.b + 'px', border: '1px dashed #93c5fd', background: '#eff6ff' }" />
        </div>
        <span class="hint">{{ w }} × {{ autoHeight ? 'auto' : h }} mm</span>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
