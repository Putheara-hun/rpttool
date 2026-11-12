<script setup lang="ts">
import { deepClone } from '../model/clone';
import { ref, toRaw } from 'vue';
import { ArrowDown, ArrowUp, Plus, Settings, Trash2 } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import ExprInput from '../components/ExprInput.vue';
import StyleEditor from '../components/StyleEditor.vue';
import type { FormatRule } from '../model/types';
import { uid } from '../model/defaults';
import { closeDialog, primaryElement, setElementProp } from '../store/designer';

const el = primaryElement.value;
const rules = ref<FormatRule[]>(deepClone((el?.formatRules ?? [])));
const selId = ref<string | null>(rules.value[0]?.id ?? null);

function add() {
  const r: FormatRule = { id: uid('r'), condition: '', style: { color: '#dc2626', bold: true } };
  rules.value.push(r);
  selId.value = r.id;
}
function move(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= rules.value.length) return;
  const a = rules.value;
  [a[i], a[j]] = [a[j], a[i]];
}
function ok() {
  if (el) setElementProp('formatRules', deepClone((rules.value)), [el.id]);
  closeDialog();
}
</script>

<template>
  <Modal :title="'Format Rules — ' + (el?.name ?? '')" :width="760" @close="closeDialog">
    <template #icon><Settings :size="16" /></template>
    <div v-if="!el" class="empty-hint">Select a single control first.</div>
    <template v-else>
      <div class="hint" style="margin-bottom: 8px">Rules are evaluated for every printed row. When the condition is true the style is applied (later rules win). Example: <code>[UnitsInStock] &lt; [ReorderLevel]</code></div>
      <div v-for="(r, i) in rules" :key="r.id" class="list-box" style="padding: 10px; margin-bottom: 8px" :style="r.id === selId ? { borderColor: 'var(--accent)' } : {}" @click="selId = r.id">
        <div class="row">
          <b>Rule {{ i + 1 }}</b>
          <span class="grow" />
          <button class="icon-btn" @click.stop="move(i, -1)"><ArrowUp :size="13" /></button>
          <button class="icon-btn" @click.stop="move(i, 1)"><ArrowDown :size="13" /></button>
          <button class="icon-btn" @click.stop="rules.splice(i, 1)"><Trash2 :size="13" /></button>
        </div>
        <div class="form-grid" style="grid-template-columns: 120px 1fr; margin-top: 6px">
          <label>Condition</label>
          <div class="row"><ExprInput v-model="r.condition" title="Rule condition" placeholder="e.g. [Amount] > 1000" /></div>
          <label>Hide control</label>
          <label class="row"><input v-model="r.hide" type="checkbox" /> Do not print the control when the condition is true</label>
        </div>
        <StyleEditor v-if="r.id === selId" :style="r.style" compact />
      </div>
      <button class="btn small" @click="add"><Plus :size="13" /> Add rule</button>
    </template>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
