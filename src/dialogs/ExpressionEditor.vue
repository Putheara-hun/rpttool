<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import Modal from '../components/Modal.vue';
import { evalExpr, FUNCTION_LIST, validate } from '../engine/expression';
import { defaultToString } from '../engine/format';
import { fieldsOf, state } from '../store/designer';
import { designCtx } from '../designer/designCtx';

const req = state.exprRequest!;
const text = ref(req.value ?? '');
const ta = ref<HTMLTextAreaElement>();
const cat = ref('Fields');
const hover = ref<{ title: string; desc: string } | null>(null);

const error = computed(() => validate(text.value));
const preview = computed(() => {
  if (!text.value.trim() || error.value) return '';
  try {
    const v = evalExpr(text.value, designCtx.value);
    const s = defaultToString(v, designCtx.value.fmt);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  } catch (e) {
    return '#Error';
  }
});

const CATS = ['Fields', 'Calculated Fields', 'Parameters', 'Aggregate', 'Logical', 'Math', 'String', 'Date', 'Conversion', 'Report', 'Operators'];
const OPERATORS: [string, string][] = [
  [' + ', 'Add numbers / concatenate text'],
  [' - ', 'Subtract'],
  [' * ', 'Multiply'],
  [' / ', 'Divide'],
  [' % ', 'Modulo'],
  [' = ', 'Equal'],
  [' <> ', 'Not equal'],
  [' < ', 'Less than'],
  [' <= ', 'Less or equal'],
  [' > ', 'Greater than'],
  [' >= ', 'Greater or equal'],
  [' And ', 'Logical AND'],
  [' Or ', 'Logical OR'],
  ['Not ', 'Logical NOT'],
  [" In ('a', 'b')", 'Value is in list'],
  [" Like '%text%'", 'Pattern match'],
  ['True', 'Boolean true'],
  ['False', 'Boolean false'],
  ['Null', 'Null value'],
  ['#2025-01-31#', 'Date literal'],
];

const items = computed<{ label: string; insert: string; desc: string; caret?: number }[]>(() => {
  const c = cat.value;
  if (c === 'Fields') {
    const id = state.report.dataSourceId;
    return id ? fieldsOf(id).map((f) => ({ label: f.name, insert: `[${f.name}]`, desc: `Field (${f.type})` })) : [];
  }
  if (c === 'Calculated Fields') return state.report.calculatedFields.map((f) => ({ label: f.name, insert: `[${f.name}]`, desc: f.expression }));
  if (c === 'Parameters') return state.report.parameters.map((p) => ({ label: p.name, insert: `?${p.name}`, desc: `Parameter (${p.type}) ${p.label}` }));
  if (c === 'Operators') return OPERATORS.map(([o, d]) => ({ label: o.trim(), insert: o, desc: d }));
  return FUNCTION_LIST.filter((f) => f.cat === c).map((f) => {
    const name = f.sig.slice(0, f.sig.indexOf('('));
    const noArgs = /\(\)$/.test(f.sig);
    return { label: f.sig, insert: noArgs ? `${name}()` : `${name}()`, caret: noArgs ? 0 : -1, desc: f.desc };
  });
});

function insert(s: string, caret = 0) {
  const el = ta.value!;
  const a = el.selectionStart ?? text.value.length;
  const b = el.selectionEnd ?? a;
  text.value = text.value.slice(0, a) + s + text.value.slice(b);
  nextTick(() => {
    el.focus();
    const pos = a + s.length + caret;
    el.setSelectionRange(pos, pos);
  });
}
function ok() {
  req.resolve(text.value.trim());
  state.exprRequest = null;
}
function cancel() {
  req.resolve(null);
  state.exprRequest = null;
}
onMounted(() => {
  ta.value?.focus();
  if (!state.report.dataSourceId) cat.value = 'Logical';
});
</script>

<template>
  <Modal :title="req.title" :width="860" @close="cancel">
    <div class="col">
      <textarea ref="ta" v-model="text" class="expr-area" spellcheck="false" placeholder="e.g. [Quantity] * [UnitPrice]   or   Iif([Amount] > 1000, 'Large', 'Small')" @keydown.ctrl.enter="ok" />
      <div class="row">
        <span v-if="!text.trim()" class="hint">Empty expression</span>
        <span v-else-if="error" class="err">✖ {{ error }}</span>
        <span v-else class="ok">✔ Valid expression</span>
        <span class="grow" />
        <span v-if="preview" class="hint" style="max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">First row result: <b>{{ preview }}</b></span>
      </div>
      <div class="split" style="height: 270px">
        <div class="list-box" style="width: 150px">
          <div v-for="c in CATS" :key="c" class="list-row" :class="{ sel: cat === c }" @click="cat = c">{{ c }}</div>
        </div>
        <div class="list-box" style="flex: 1">
          <div v-if="!items.length" class="empty-hint">Nothing here.</div>
          <div
            v-for="it in items"
            :key="it.label"
            class="list-row"
            style="font-family: Consolas, monospace; font-size: 12px"
            @mouseenter="hover = { title: it.label, desc: it.desc }"
            @click="insert(it.insert, it.caret === -1 ? -1 : 0)"
            :title="'Click to insert'"
          >
            {{ it.label }}
          </div>
        </div>
        <div style="width: 230px; font-size: 12px; line-height: 1.5" class="list-box">
          <div style="padding: 10px">
            <template v-if="hover">
              <b style="font-family: Consolas, monospace">{{ hover.title }}</b>
              <p class="muted">{{ hover.desc }}</p>
            </template>
            <template v-else>
              <b>Syntax</b>
              <p class="muted">
                Fields: <code>[Name]</code><br />Parameters: <code>?Name</code><br />Text: <code>'abc'</code><br />Dates: <code>#2025-12-31#</code><br />Aggregates (Sum, Count…) work over the current group, report or page depending on the band.<br />
                Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to accept.
              </p>
            </template>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="text = ''">Clear</button>
      <span class="grow" />
      <button class="btn" @click="cancel">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
