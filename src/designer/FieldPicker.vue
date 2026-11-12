<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Check, Database, Pencil, Search, Type, X } from 'lucide-vue-next';
import { fieldsOf, state, type FieldChoice } from '../store/designer';
import { specialFields } from './specialFields';

const props = defineProps<{ x: number; y: number; width: number; current: string; allowText: boolean; title: string; dataSourceId?: string | null; masterDataSourceId?: string | null }>();
const emit = defineEmits<{ choose: [f: FieldChoice]; setText: [text: string]; editText: []; expression: []; clear: []; close: [] }>();

const q = ref('');
const hi = ref(0);
const root = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const list = ref<HTMLElement>();

const BADGE: Record<string, string> = { string: 'abc', number: '123', date: 'dt', boolean: 'y/n', calc: 'ƒx', param: '?', no: '#', pg: 'pg', dt: 'dt', abc: 'abc' };
const TEXT = '\u0000text';

const groups = computed(() => {
  const r = state.report;
  const dsId = props.dataSourceId !== undefined ? props.dataSourceId : (r.dataSourceId ?? r.dataSources[0]?.id ?? null);
  const ds = r.dataSources.find((d) => d.id === dsId);
  const out: { title: string; items: (FieldChoice & { badge: string })[] }[] = [];
  if (ds) out.push({ title: ds.name, items: fieldsOf(ds.id).map((f) => ({ expr: `[${f.name}]`, name: f.name, type: f.type, badge: f.type })) });
  const master = props.masterDataSourceId ? r.dataSources.find((d) => d.id === props.masterDataSourceId) : null;
  if (master)
    out.push({
      title: `Parent row — ${master.name}`,
      items: fieldsOf(master.id).map((f) => ({ expr: `[Master.${f.name}]`, name: `Master.${f.name}`, type: f.type, badge: f.type })),
    });
  if (r.calculatedFields.length) out.push({ title: 'Calculated fields', items: r.calculatedFields.map((c) => ({ expr: `[${c.name}]`, name: c.name, type: 'calc', badge: 'calc' })) });
  if (r.parameters.length) out.push({ title: 'Parameters', items: r.parameters.map((p) => ({ expr: `?${p.name}`, name: p.name, type: p.type, badge: 'param' })) });
  out.push({ title: 'Special — row No., page No., date', items: specialFields(r) });
  const f = q.value.trim().toLowerCase();
  return out.map((g) => ({ ...g, items: f ? g.items.filter((i) => i.name.toLowerCase().includes(f)) : g.items })).filter((g) => g.items.length);
});
const fields = computed(() => groups.value.flatMap((g) => g.items));
/** typed text that can be used as a static caption */
const typed = computed(() => (props.allowText ? q.value.trim() : ''));
/** keyboard order: matching fields, then the "use as text" entry */
const options = computed(() => [...fields.value.map((f) => f.expr), ...(typed.value ? [TEXT] : [])]);
const isCurrent = (expr: string) => props.current.trim().toLowerCase() === expr.toLowerCase();

function move(d: number) {
  if (!options.value.length) return;
  hi.value = (hi.value + d + options.value.length) % options.value.length;
  nextTick(() => list.value?.querySelector('.fp-item.hi')?.scrollIntoView({ block: 'nearest' }));
}
function pick(key: string | undefined) {
  if (!key) return;
  if (key === TEXT) emit('setText', typed.value);
  else {
    const f = fields.value.find((i) => i.expr === key);
    if (f) emit('choose', f);
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(options.value[hi.value]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
function onOutside(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) emit('close');
}
onMounted(() => {
  const cur = fields.value.findIndex((i) => isCurrent(i.expr));
  if (cur >= 0) hi.value = cur;
  input.value?.focus();
  nextTick(() => list.value?.querySelector('.fp-item.hi')?.scrollIntoView({ block: 'center' }));
  setTimeout(() => document.addEventListener('mousedown', onOutside, true));
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside, true));
</script>

<template>
  <Teleport to="body">
    <div ref="root" class="field-picker" :style="{ left: x + 'px', top: y + 'px', width: width + 'px' }" @contextmenu.prevent>
      <div class="fp-title"><Database :size="13" /> {{ title }}</div>
      <div class="fp-search">
        <Search :size="14" class="muted" />
        <input ref="input" v-model="q" :placeholder="allowText ? 'Search fields, or type text…' : 'Search fields…'" @input="hi = 0" @keydown="onKey" />
      </div>
      <div ref="list" class="fp-list">
        <template v-for="g in groups" :key="g.title">
          <div class="fp-group">{{ g.title }}</div>
          <div
            v-for="it in g.items"
            :key="it.expr"
            class="fp-item"
            :class="{ hi: options[hi] === it.expr, current: isCurrent(it.expr) }"
            :title="'desc' in it ? String(it.desc) : it.expr"
            @mouseenter="hi = options.indexOf(it.expr)"
            @click="pick(it.expr)"
          >
            <span class="field-type" :class="it.badge">{{ BADGE[it.badge] ?? it.badge }}</span>
            <span class="grow" style="overflow: hidden; text-overflow: ellipsis">{{ it.name }}</span>
            <Check v-if="isCurrent(it.expr)" :size="14" />
          </div>
        </template>
        <template v-if="typed">
          <div class="fp-group">Text</div>
          <div class="fp-item" :class="{ hi: options[hi] === TEXT }" @mouseenter="hi = options.indexOf(TEXT)" @click="pick(TEXT)">
            <Type :size="14" />
            <span class="grow" style="overflow: hidden; text-overflow: ellipsis">Use “{{ typed }}” as text</span>
          </div>
        </template>
      </div>
      <div v-if="!state.report.dataSources.length" class="empty-hint" style="padding: 4px 10px">No data fields yet — add a data source in Report ▸ Data Sources.</div>
      <div class="fp-foot">
        <button v-if="allowText" class="btn small" title="Edit static text in the cell" @click="emit('editText')"><Pencil :size="12" /> Edit text</button>
        <button class="btn small" title="Open the expression editor" @click="emit('expression')"><span style="font-family: Georgia, serif; font-style: italic; font-weight: 700">ƒ</span> Expression…</button>
        <span class="grow" />
        <button v-if="current" class="btn small" title="Remove the field binding" @click="emit('clear')"><X :size="12" /> Clear</button>
      </div>
    </div>
  </Teleport>
</template>
