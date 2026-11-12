<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, ref, toRaw } from 'vue';
import { Stamp, Upload } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import ColorInput from '../components/ColorInput.vue';
import { closeDialog, mutate, state } from '../store/designer';
import { watermarkSvg } from '../export/svg';

const wm = ref(deepClone((state.report.watermark)));
const pw = state.report.page.width;
const ph = state.report.page.height;
const preview = computed(() => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pw} ${ph}" width="100%" height="100%"><rect width="${pw}" height="${ph}" fill="#fff"/>${
  [80, 120, 160, 200, 240, 280, 320].map((y) => `<rect x="60" y="${y}" width="${pw - 120}" height="14" fill="#e5e7eb"/>`).join('')
}${wm.value.enabled ? watermarkSvg(wm.value, pw, ph) : ''}</svg>`);
function pickImage() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => (wm.value.image = String(rd.result));
    rd.readAsDataURL(f);
  };
  inp.click();
}
function ok() {
  mutate((r) => (r.watermark = deepClone((wm.value))));
  closeDialog();
}
</script>

<template>
  <Modal title="Watermark" :width="720" @close="closeDialog">
    <template #icon><Stamp :size="16" /></template>
    <div class="split">
      <div class="form-grid" style="flex: 1; align-content: start">
        <label>Enabled</label>
        <label class="row"><input v-model="wm.enabled" type="checkbox" /> Print a watermark on every page</label>
        <label>Text</label>
        <input v-model="wm.text" />
        <label>Font size (pt)</label>
        <input v-model.number="wm.fontSize" type="number" min="8" />
        <label>Color</label>
        <ColorInput v-model="wm.color" :clearable="false" />
        <label>Text opacity</label>
        <input v-model.number="wm.opacity" type="range" min="0.05" max="1" step="0.05" />
        <label>Angle</label>
        <input v-model.number="wm.angle" type="number" min="-90" max="90" />
        <label>Image</label>
        <div class="row">
          <button class="btn small" @click="pickImage"><Upload :size="13" /> Choose…</button>
          <button v-if="wm.image" class="btn small" @click="wm.image = ''">Remove</button>
          <img v-if="wm.image" :src="wm.image" style="height: 26px" />
        </div>
        <label>Image opacity</label>
        <input v-model.number="wm.imageOpacity" type="range" min="0.05" max="1" step="0.05" />
        <label>Position</label>
        <select v-model="wm.behind"><option :value="true">Behind content</option><option :value="false">In front of content</option></select>
      </div>
      <div style="width: 200px; height: 280px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2)" v-html="preview" />
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
