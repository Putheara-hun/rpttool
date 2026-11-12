<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { Baseline, ChevronDown, PaintBucket, Pipette, Square } from 'lucide-vue-next';
import { addRecent, clamp, hsvToHex, recentColors, rgbToHsv, hexToRgb, STANDARD, themeColumns, toHex } from './colors';

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    /** shown when modelValue is empty (inherited / automatic colour) */
    placeholder?: string;
    /** swatch = square for forms; text / fill / border = ribbon buttons with a colour bar */
    variant?: 'swatch' | 'text' | 'fill' | 'border';
    noneLabel?: string;
    allowNone?: boolean;
    title?: string;
    disabled?: boolean;
  }>(),
  { variant: 'swatch', noneLabel: 'No color', allowNone: true, title: 'Color' },
);
const emit = defineEmits<{ 'update:modelValue': [v: string | undefined] }>();
// two root nodes (button + teleported popup): class / style from the parent go to the button
defineOptions({ inheritAttrs: false });

const open = ref(false);
const anchor = ref<HTMLElement>();
const pop = ref<HTMLElement>();
const pos = ref({ x: 0, y: 0 });
const showCustom = ref(false);
const hsv = reactive({ h: 210, s: 0.7, v: 0.8 });
const hexText = ref('');
const columns = themeColumns();
const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

const current = computed(() => toHex(props.modelValue));
const shown = computed(() => current.value ?? toHex(props.placeholder));
const customHex = computed(() => hsvToHex(hsv.h, hsv.s, hsv.v));
const ICONS = { text: Baseline, fill: PaintBucket, border: Square } as const;

function syncFrom(hex: string | null) {
  const rgb = hex ? hexToRgb(hex) : null;
  if (rgb) Object.assign(hsv, rgbToHsv(...rgb));
  hexText.value = hex ?? '';
}
async function toggle() {
  if (props.disabled) return;
  if (open.value) return close();
  syncFrom(shown.value);
  showCustom.value = false;
  open.value = true;
  await nextTick();
  place();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}
/** Keep the popup fully on screen: below the button, else above it, else pinned to the top (scrollable). */
function place() {
  if (!anchor.value) return;
  const r = anchor.value.getBoundingClientRect();
  const w = pop.value?.offsetWidth ?? 240;
  const h = pop.value?.scrollHeight ?? 300;
  const vh = window.innerHeight;
  let x = r.left;
  if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
  let y = r.bottom + 4;
  if (y + h > vh - 8) y = r.top - h - 4 >= 8 ? r.top - h - 4 : Math.max(8, vh - h - 8);
  pos.value = { x: Math.max(8, x), y: Math.max(8, y) };
}
watch(showCustom, () => nextTick(place));
function close() {
  open.value = false;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
onBeforeUnmount(close);
function onOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (pop.value?.contains(t) || anchor.value?.contains(t)) return;
  close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}
function choose(hex: string | undefined) {
  if (hex) addRecent(hex);
  emit('update:modelValue', hex);
  close();
}
function applyHexText() {
  const h = toHex(hexText.value);
  if (h) choose(h);
}
/** OK in the custom panel: a typed colour wins over the slider colour */
function applyCustom() {
  const typed = toHex(hexText.value);
  choose(typed && typed !== customHex.value ? typed : customHex.value);
}
async function eyedrop() {
  try {
    const r = await new (window as any).EyeDropper().open();
    if (r?.sRGBHex) {
      syncFrom(toHex(r.sRGBHex));
      choose(toHex(r.sRGBHex)!);
    }
  } catch {
    /* cancelled */
  }
}

// ---- saturation / value square and hue bar
function drag(e: MouseEvent, fn: (x: number, y: number) => void) {
  const el = e.currentTarget as HTMLElement;
  const move = (ev: MouseEvent) => {
    const r = el.getBoundingClientRect();
    fn(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height));
    hexText.value = customHex.value;
  };
  move(e);
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
const onSv = (e: MouseEvent) => drag(e, (x, y) => ((hsv.s = x), (hsv.v = 1 - y)));
const onHue = (e: MouseEvent) => drag(e, (x) => (hsv.h = Math.min(359.9, x * 360)));
</script>

<template>
  <button ref="anchor" v-bind="$attrs" type="button" class="cp-trigger" :class="[variant, { open, disabled }]" :disabled="disabled" :title="title" @click="toggle">
    <template v-if="variant === 'swatch'">
      <span class="cp-swatch" :class="{ none: !shown, inherited: !current && !!shown }" :style="shown ? { background: shown } : undefined" />
    </template>
    <template v-else>
      <span class="cp-icon">
        <component :is="ICONS[variant]" :size="15" />
        <span class="cp-bar" :class="{ none: !shown }" :style="shown ? { background: shown } : undefined" />
      </span>
    </template>
    <ChevronDown :size="10" class="cp-caret" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="pop" class="cp-pop" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @mousedown.stop>
      <button v-if="allowNone" type="button" class="cp-none" @click="choose(undefined)">
        <span class="cp-swatch none" /> {{ noneLabel }}
      </button>
      <div class="cp-label">Theme colors</div>
      <div class="cp-theme">
        <div v-for="(col, ci) in columns" :key="ci" class="cp-col">
          <button
            v-for="(c, ri) in col"
            :key="c"
            type="button"
            class="cp-cell"
            :class="{ first: ri === 0, sel: current === c }"
            :style="{ background: c }"
            :title="c"
            @click="choose(c)"
          />
        </div>
      </div>
      <div class="cp-label">Standard colors</div>
      <div class="cp-row">
        <button v-for="c in STANDARD" :key="c" type="button" class="cp-cell first" :class="{ sel: current === c }" :style="{ background: c }" :title="c" @click="choose(c)" />
      </div>
      <template v-if="recentColors.length">
        <div class="cp-label">Recent colors</div>
        <div class="cp-row">
          <button v-for="c in recentColors" :key="c" type="button" class="cp-cell first" :class="{ sel: current === c }" :style="{ background: c }" :title="c" @click="choose(c)" />
        </div>
      </template>
      <div class="cp-actions">
        <button type="button" class="btn small" @click="showCustom = !showCustom">{{ showCustom ? 'Hide' : 'More colors…' }}</button>
        <button v-if="hasEyeDropper" type="button" class="btn small" title="Pick a color from anywhere on the screen" @click="eyedrop"><Pipette :size="12" /> Pick</button>
      </div>
      <div v-if="showCustom" class="cp-custom">
        <div class="cp-sv" :style="{ background: `hsl(${hsv.h}, 100%, 50%)` }" @mousedown.prevent="onSv">
          <div class="cp-sv-white" />
          <div class="cp-sv-black" />
          <div class="cp-sv-handle" :style="{ left: hsv.s * 100 + '%', top: (1 - hsv.v) * 100 + '%', background: customHex }" />
        </div>
        <div class="cp-hue" @mousedown.prevent="onHue">
          <div class="cp-hue-handle" :style="{ left: (hsv.h / 360) * 100 + '%' }" />
        </div>
        <div class="row" style="gap: 6px">
          <span class="cp-swatch big" :style="{ background: customHex }" />
          <input v-model="hexText" class="cp-hex" maxlength="20" placeholder="#RRGGBB or name" @keydown.enter.prevent="applyHexText" />
          <button type="button" class="btn small primary" @click="applyCustom">OK</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
