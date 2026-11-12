<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, ref, toRaw } from 'vue';
import { Plus, Trash2, Variable } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import type { ParameterDef } from '../model/types';
import { uid } from '../model/defaults';
import { closeDialog, mutate, notify, state } from '../store/designer';

const list = ref<ParameterDef[]>(deepClone((state.report.parameters)));
const selId = ref<string | null>(list.value[0]?.id ?? null);
const cur = computed(() => list.value.find((p) => p.id === selId.value) ?? null);

function add() {
  let n = list.value.length + 1;
  while (list.value.some((p) => p.name === 'Parameter' + n)) n++;
  const p: ParameterDef = { id: uid('p'), name: 'Parameter' + n, label: '', type: 'string', defaultValue: '', values: '', visible: true };
  list.value.push(p);
  selId.value = p.id;
}
function remove() {
  list.value = list.value.filter((p) => p.id !== selId.value);
  selId.value = list.value[0]?.id ?? null;
}
function ok() {
  const names = new Set<string>();
  for (const p of list.value) {
    if (!/^[A-Za-z_][\w]*$/.test(p.name)) return notify(`Invalid parameter name "${p.name}" (letters, digits, _)`, 'error');
    if (names.has(p.name)) return notify('Duplicate parameter: ' + p.name, 'error');
    names.add(p.name);
  }
  mutate((r) => (r.parameters = deepClone((list.value))));
  closeDialog();
}
</script>

<template>
  <Modal title="Report Parameters" :width="720" @close="closeDialog">
    <template #icon><Variable :size="16" /></template>
    <div class="split" style="height: 340px">
      <div class="col" style="width: 210px">
        <div class="list-box" style="flex: 1">
          <div v-for="p in list" :key="p.id" class="list-row" :class="{ sel: p.id === selId }" @click="selId = p.id">
            <span class="field-type param">?</span>{{ p.name }}<span class="grow" /><span class="hint">{{ p.type }}</span>
          </div>
          <div v-if="!list.length" class="empty-hint">No parameters. Parameters let users enter values (e.g. a date range or ID) before the report is generated.</div>
        </div>
        <div class="row">
          <button class="btn small" @click="add"><Plus :size="13" /> Add</button>
          <button class="btn small danger" :disabled="!cur" @click="remove"><Trash2 :size="13" /> Remove</button>
        </div>
      </div>
      <div v-if="cur" class="form-grid" style="flex: 1; align-content: start">
        <label>Name</label><input v-model="cur.name" />
        <label>Prompt text</label><input v-model="cur.label" placeholder="Shown in the preview parameter panel" />
        <label>Type</label>
        <select v-model="cur.type">
          <option value="string">Text</option>
          <option value="number">Number</option>
          <option value="date">Date</option>
          <option value="boolean">Boolean</option>
        </select>
        <label>Default value</label>
        <input v-model="cur.defaultValue" :type="cur.type === 'date' ? 'date' : cur.type === 'number' ? 'number' : 'text'" />
        <label>Allowed values</label>
        <input v-model="cur.values" placeholder="optional, comma separated: USA, UK, France" />
        <label>Visible</label>
        <label class="row"><input v-model="cur.visible" type="checkbox" /> Ask for this value in the preview</label>
        <label />
        <div class="hint">Use it in expressions as <code>?{{ cur.name }}</code>, e.g. filter <code>[Country] = ?{{ cur.name }}</code> or text <code>{?{{ cur.name }}}</code>.</div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
