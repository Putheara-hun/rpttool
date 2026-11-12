<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, ref, toRaw } from 'vue';
import { Calculator, Plus, Trash2 } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import ExprInput from '../components/ExprInput.vue';
import type { CalcFieldDef } from '../model/types';
import { uid } from '../model/defaults';
import { closeDialog, mutate, notify, state } from '../store/designer';
import { evalExpr, parse, type Node } from '../engine/expression';
import { defaultToString } from '../engine/format';
import { designCtx } from '../designer/designCtx';

const list = ref<CalcFieldDef[]>(deepClone((state.report.calculatedFields)));
const selId = ref<string | null>(list.value[0]?.id ?? null);
const cur = computed(() => list.value.find((p) => p.id === selId.value) ?? null);

const sample = computed(() => {
  const c = cur.value;
  if (!c || !c.expression) return '';
  const calc = new Map<string, Node>();
  for (const f of list.value) {
    try {
      calc.set(f.name.toLowerCase(), parse(f.expression || 'null'));
    } catch {
      /* shown as error */
    }
  }
  const ctx = { ...designCtx.value, calc };
  return ctx.rows
    .slice(0, 5)
    .map((row) => defaultToString(evalExpr(c.expression, { ...ctx, row }), ctx.fmt))
    .join('  |  ');
});

function add() {
  let n = list.value.length + 1;
  while (list.value.some((p) => p.name === 'CalcField' + n)) n++;
  const f: CalcFieldDef = { id: uid('c'), name: 'CalcField' + n, expression: '' };
  list.value.push(f);
  selId.value = f.id;
}
function remove() {
  list.value = list.value.filter((p) => p.id !== selId.value);
  selId.value = list.value[0]?.id ?? null;
}
function ok() {
  const names = new Set<string>();
  for (const f of list.value) {
    if (!/^[A-Za-z_][\w ]*$/.test(f.name)) return notify(`Invalid field name "${f.name}"`, 'error');
    if (names.has(f.name.toLowerCase())) return notify('Duplicate field: ' + f.name, 'error');
    names.add(f.name.toLowerCase());
  }
  mutate((r) => (r.calculatedFields = deepClone((list.value))));
  closeDialog();
}
</script>

<template>
  <Modal title="Calculated Fields" :width="760" @close="closeDialog">
    <template #icon><Calculator :size="16" /></template>
    <div class="split" style="height: 300px">
      <div class="col" style="width: 210px">
        <div class="list-box" style="flex: 1">
          <div v-for="f in list" :key="f.id" class="list-row" :class="{ sel: f.id === selId }" @click="selId = f.id"><span class="field-type calc">ƒx</span>{{ f.name }}</div>
          <div v-if="!list.length" class="empty-hint">Calculated fields are virtual columns computed per row, e.g. <code>[Quantity] * [UnitPrice]</code>.</div>
        </div>
        <div class="row">
          <button class="btn small" @click="add"><Plus :size="13" /> Add</button>
          <button class="btn small danger" :disabled="!cur" @click="remove"><Trash2 :size="13" /> Remove</button>
        </div>
      </div>
      <div v-if="cur" class="form-grid" style="flex: 1; align-content: start">
        <label>Name</label><input v-model="cur.name" />
        <label>Expression</label>
        <div class="row"><ExprInput v-model="cur.expression" :title="'Calculated field — ' + cur.name" /></div>
        <label>First rows</label>
        <div class="hint" style="font-family: Consolas, monospace">{{ sample || '—' }}</div>
        <label />
        <div class="hint">Reference it like any other field: <code>[{{ cur.name }}]</code>. Calculated fields can be grouped, sorted, summarized and charted.</div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
