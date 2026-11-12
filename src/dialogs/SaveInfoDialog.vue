<script setup lang="ts">
import { Info } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { closeDialog, state } from '../store/designer';

/** Result of saving / opening HTML or RDL: written files and conversion notes. */
const p = (state.dialogProps ?? { title: 'Saved', files: [], warnings: [] }) as { title: string; note?: string; files: string[]; warnings: string[] };
</script>

<template>
  <Modal :title="p.title" :width="660" @close="closeDialog">
    <template #icon><Info :size="16" /></template>
    <p v-if="p.note" class="save-note">{{ p.note }}</p>
    <template v-if="p.files.length">
      <div class="section-title" style="margin-top: 0">{{ p.files.length === 1 ? 'File' : 'Files' }}</div>
      <ul class="save-files">
        <li v-for="f in p.files" :key="f"><code>{{ f }}</code></li>
      </ul>
    </template>
    <template v-if="p.warnings.length">
      <div class="section-title">Conversion notes ({{ p.warnings.length }})</div>
      <ul class="save-warnings">
        <li v-for="(w, i) in p.warnings" :key="i">{{ w }}</li>
      </ul>
    </template>
    <template #footer>
      <button class="btn primary" @click="closeDialog">OK</button>
    </template>
  </Modal>
</template>
