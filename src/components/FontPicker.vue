<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronDown, Cloud, Search } from 'lucide-vue-next';
import { GOOGLE_FONTS, SYSTEM_FONTS, isGoogleFont, loadFontPreview, loadGoogleFont, previewFamily, usedFamilies, type FontCategory } from '../engine/fonts';
import { KHMER_OS_FONTS, khmerOsNamesOf, webFallback } from '../engine/fontAliases';
import { mutate, notify, state } from '../store/designer';

const props = withDefaults(defineProps<{ modelValue?: string; placeholder?: string; disabled?: boolean; width?: string }>(), { width: '140px' });
const emit = defineEmits<{ 'update:modelValue': [v: string | undefined] }>();
defineOptions({ inheritAttrs: false });

const open = ref(false);
const q = ref('');
const hi = ref(0);
const anchor = ref<HTMLElement>();
const pop = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const listEl = ref<HTMLElement>();
const pos = ref({ x: 0, y: 0 });
const busy = ref('');

const current = computed(() => props.modelValue || props.placeholder || '');
const extra = computed(() => state.report.fonts ?? []);
/**
 * How a name is drawn in the list: system fonts directly, Google fonts through a tiny preview face,
 * Khmer OS fonts in themselves when installed, otherwise in their Google version.
 */
function face(f: string) {
  if (isGoogleFont(f, extra.value)) return `"${f}", "${previewFamily(f)}", sans-serif`;
  const fb = webFallback(f);
  return fb ? `"${f}", "${fb}", "${previewFamily(fb)}", sans-serif` : `"${f}", sans-serif`;
}
/** the Google family whose preview face an item needs */
const previewOf = (it: Item) => (it.google ? it.family : webFallback(it.family));

interface Item {
  family: string;
  /** small grey text after the name; also searched ("Khmer OS Battambang" finds Battambang) */
  note?: string;
  google: boolean;
}
const groups = computed(() => {
  const f = q.value.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);
  const used = [...usedFamilies(state.report)].sort();
  const out: { title: string; items: Item[] }[] = [];
  const push = (title: string, items: Item[]) => {
    const list = items.filter((i) => match(i.family) || (!!i.note && match(i.note)));
    if (list.length) out.push({ title, items: list });
  };
  push(
    'In this report',
    used.map((u) => ({ family: u, google: isGoogleFont(u, extra.value) })),
  );
  if (extra.value.length) push('Added Google fonts', extra.value.filter((x) => !used.includes(x)).map((x) => ({ family: x, google: true })));
  push(
    'Khmer OS — Google version where not installed',
    KHMER_OS_FONTS.map((k) => ({ family: k, note: '☁ ' + webFallback(k), google: false })),
  );
  const cats: FontCategory[] = ['Khmer', 'Sans serif', 'Serif', 'Monospace', 'Display', 'Handwriting', 'Thai / Lao'];
  for (const c of cats)
    push(
      `Google Fonts — ${c}`,
      GOOGLE_FONTS.filter((g) => g.cat === c).map((g) => ({ family: g.family, note: khmerOsNamesOf(g.family).join(' / ') || undefined, google: true })),
    );
  push(
    'Installed on this computer',
    SYSTEM_FONTS.map((s) => ({ family: s, google: false })),
  );
  return out;
});
const flat = computed(() => groups.value.flatMap((g) => g.items.map((i) => i.family)));
/** typed name that is not in the lists: try it on Google Fonts */
const custom = computed(() => {
  const t = q.value.trim();
  if (!t || flat.value.some((f) => f.toLowerCase() === t.toLowerCase())) return '';
  return t.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
});
const options = computed(() => [...flat.value, ...(custom.value ? ['\u0000custom'] : [])]);

async function toggle() {
  if (props.disabled) return;
  if (open.value) return close();
  q.value = '';
  open.value = true;
  await nextTick();
  place();
  hi.value = Math.max(0, flat.value.findIndex((f) => f === current.value));
  input.value?.focus();
  nextTick(() => listEl.value?.querySelector('.fpk-item.hi')?.scrollIntoView({ block: 'center' }));
  observeItems();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onDocKey, true);
}
/** Esc closes the list (and does not reach the designer, which would clear the selection) */
function onDocKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  close();
}
function place() {
  if (!anchor.value) return;
  const r = anchor.value.getBoundingClientRect();
  const w = pop.value?.offsetWidth ?? 280;
  const h = pop.value?.offsetHeight ?? 420;
  let x = Math.min(r.left, window.innerWidth - w - 8);
  let y = r.bottom + 3;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 3);
  pos.value = { x: Math.max(8, x), y };
}
/** previews only for the names that scroll into view (the browser fetches just the letters it needs) */
let io: IntersectionObserver | null = null;
function observeItems() {
  io?.disconnect();
  if (!listEl.value || typeof IntersectionObserver === 'undefined') return;
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const f = (en.target as HTMLElement).dataset.family;
        if (en.isIntersecting && f) {
          loadFontPreview(f);
          io?.unobserve(en.target);
        }
      }
    },
    { root: listEl.value, rootMargin: '150px' },
  );
  listEl.value.querySelectorAll<HTMLElement>('.fpk-item[data-family]').forEach((n) => io!.observe(n));
}
watch(groups, () => open.value && nextTick(observeItems));

function close() {
  io?.disconnect();
  open.value = false;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onDocKey, true);
}
onBeforeUnmount(close);
function onOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (pop.value?.contains(t) || anchor.value?.contains(t)) return;
  close();
}
async function choose(family: string) {
  close();
  emit('update:modelValue', family);
  // a Google font, or the Google version of a Khmer OS font (shown where the Khmer OS font is not installed)
  const web = isGoogleFont(family, extra.value) ? family : webFallback(family);
  if (web) {
    const ok = await loadGoogleFont(web);
    if (!ok) notify(`Could not load "${web}" from Google Fonts (check the internet connection)`, 'error');
  }
}
async function useCustom() {
  const family = custom.value;
  if (!family) return;
  busy.value = family;
  const ok = await loadGoogleFont(family);
  busy.value = '';
  if (!ok) {
    input.value?.focus();
    return notify(`"${family}" was not found on Google Fonts — check the spelling (e.g. "Kantumruy Pro")`, 'error');
  }
  mutate((r) => {
    r.fonts = [...new Set([...(r.fonts ?? []), family])];
  });
  close();
  emit('update:modelValue', family);
  notify(`Google font "${family}" added`, 'success');
}
function pick(key: string | undefined) {
  if (!key) return;
  if (key === '\u0000custom') void useCustom();
  else void choose(key);
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = options.value.length;
    if (!n) return;
    hi.value = (hi.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    nextTick(() => listEl.value?.querySelector('.fpk-item.hi')?.scrollIntoView({ block: 'nearest' }));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(options.value[hi.value]);
  }
}
</script>

<template>
  <button
    ref="anchor"
    v-bind="$attrs"
    type="button"
    class="fpk-trigger"
    :class="{ open, inherited: !modelValue }"
    :disabled="disabled"
    :style="{ width }"
    :title="current ? `Font: ${current}` : 'Font'"
    @click="toggle"
  >
    <span class="fpk-name" :style="{ fontFamily: current ? face(current) : undefined }">{{ current || '(font)' }}</span>
    <ChevronDown :size="12" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="pop" class="fpk-pop" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @mousedown.stop>
      <div class="fpk-search">
        <Search :size="14" class="muted" />
        <input ref="input" v-model="q" placeholder="Search fonts, or type any Google font name…" @input="hi = 0" @keydown="onKey" />
      </div>
      <div ref="listEl" class="fpk-list">
        <template v-for="g in groups" :key="g.title">
          <div class="fpk-group">{{ g.title }}</div>
          <div
            v-for="it in g.items"
            :key="g.title + it.family"
            class="fpk-item"
            :data-family="previewOf(it)"
            :class="{ hi: options[hi] === it.family, cur: it.family === current }"
            @mouseenter="hi = options.indexOf(it.family)"
            @click="choose(it.family)"
          >
            <span class="fpk-sample" :style="{ fontFamily: face(it.family) }">{{ it.family }}</span>
            <span v-if="it.note" class="fpk-note">{{ it.note }}</span>
            <Cloud v-if="it.google" :size="12" class="muted" title="Google font (downloaded when used)" />
          </div>
        </template>
        <div v-if="custom" class="fpk-item fpk-custom" :class="{ hi: options[hi] === '\u0000custom' }" @mouseenter="hi = options.indexOf('\u0000custom')" @click="useCustom">
          <Cloud :size="13" />
          <span>{{ busy ? `Loading “${busy}”…` : `Use Google font “${custom}”` }}</span>
        </div>
        <div v-if="!flat.length && !custom" class="empty-hint">No font matches.</div>
      </div>
      <div class="fpk-foot">Google fonts (☁) are downloaded from fonts.google.com when used — any family from fonts.google.com can be typed above.</div>
    </div>
  </Teleport>
</template>
