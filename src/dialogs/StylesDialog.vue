<script setup lang="ts">
import { deepClone } from '../model/clone';
import { computed, ref, toRaw } from 'vue';
import { Palette, Plus, Trash2 } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import StyleEditor from '../components/StyleEditor.vue';
import type { NamedStyle } from '../model/types';
import { resolveStyle, uid, PT } from '../model/defaults';
import { closeDialog, mutate, notify, primaryElement, state } from '../store/designer';

const list = ref<NamedStyle[]>(deepClone((state.report.styles)));
const original = new Map(state.report.styles.map((s) => [s.id, s.name]));
const selId = ref<string | null>(list.value[0]?.id ?? null);
const cur = computed(() => list.value.find((s) => s.id === selId.value) ?? null);

function add(fromSelection = false) {
  let n = list.value.length + 1;
  while (list.value.some((s) => s.name === 'Style' + n)) n++;
  const st: NamedStyle = { id: uid('s'), name: 'Style' + n, style: {} };
  if (fromSelection && primaryElement.value) st.style = deepClone((primaryElement.value.style));
  list.value.push(st);
  selId.value = st.id;
}
function remove() {
  list.value = list.value.filter((s) => s.id !== selId.value);
  selId.value = list.value[0]?.id ?? null;
}
const previewCss = computed(() => {
  if (!cur.value) return {};
  const tmp = { ...state.report, styles: [cur.value] } as any;
  const s = resolveStyle(tmp, cur.value.name, {});
  const b = s.borders;
  const border = `${s.borderWidth}px ${s.borderStyle} ${s.borderColor}`;
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize * PT + 'px',
    fontWeight: s.bold ? 'bold' : 'normal',
    fontStyle: s.italic ? 'italic' : 'normal',
    textDecoration: [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].join(' ').trim() || 'none',
    color: s.color,
    background: s.backColor || 'transparent',
    textAlign: s.textAlign === 'justify' ? 'left' : s.textAlign,
    padding: s.padding + 'px',
    borderTop: b.includes('t') ? border : 'none',
    borderRight: b.includes('r') ? border : 'none',
    borderBottom: b.includes('b') ? border : 'none',
    borderLeft: b.includes('l') ? border : 'none',
  } as Record<string, string>;
});
function ok() {
  const names = new Set<string>();
  for (const s of list.value) {
    if (!s.name.trim()) return notify('Style name required', 'error');
    if (names.has(s.name)) return notify('Duplicate style: ' + s.name, 'error');
    names.add(s.name);
  }
  mutate((r) => {
    const renames = new Map<string, string>();
    for (const s of list.value) {
      const old = original.get(s.id);
      if (old && old !== s.name) renames.set(old, s.name);
    }
    const existing = new Set(list.value.map((s) => s.name));
    for (const el of r.elements) {
      if (!el.styleName) continue;
      if (renames.has(el.styleName)) el.styleName = renames.get(el.styleName);
      else if (!existing.has(el.styleName)) el.styleName = undefined;
    }
    r.styles = deepClone((list.value));
  });
  closeDialog();
}
</script>

<template>
  <Modal title="Style Sheet" :width="820" @close="closeDialog">
    <template #icon><Palette :size="16" /></template>
    <div class="split" style="min-height: 380px">
      <div class="col" style="width: 200px">
        <div class="list-box" style="flex: 1">
          <div v-for="s in list" :key="s.id" class="list-row" :class="{ sel: s.id === selId }" @click="selId = s.id">{{ s.name }}</div>
          <div v-if="!list.length" class="empty-hint">Named styles can be applied to many controls through their <b>Style</b> property. Inline properties override the style.</div>
        </div>
        <button class="btn small" @click="add()"><Plus :size="13" /> New style</button>
        <button class="btn small" :disabled="!primaryElement" @click="add(true)"><Plus :size="13" /> From selected control</button>
        <button class="btn small danger" :disabled="!cur" @click="remove"><Trash2 :size="13" /> Delete</button>
      </div>
      <div v-if="cur" class="col" style="flex: 1">
        <div class="form-grid" style="grid-template-columns: 120px 1fr">
          <label>Name</label>
          <input v-model="cur.name" />
        </div>
        <StyleEditor :key="cur.id" :style="cur.style" />
        <div class="section-title">Preview</div>
        <div :style="previewCss">The quick brown fox jumps over the lazy dog 1,234.56</div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="closeDialog">Cancel</button>
      <button class="btn primary" @click="ok">OK</button>
    </template>
  </Modal>
</template>
