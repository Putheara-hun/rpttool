<script setup lang="ts">
import type { StyleProps } from '../model/types';
import ColorInput from './ColorInput.vue';
import FontPicker from './FontPicker.vue';

const props = defineProps<{ style: StyleProps; compact?: boolean }>();
const s = props.style as any;
function set(k: keyof StyleProps, v: unknown) {
  if (v === '' || v === undefined || v === null || (typeof v === 'number' && isNaN(v))) delete s[k];
  else s[k] = v;
}
function tri(k: keyof StyleProps, e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  set(k, v === '' ? undefined : v === 'true');
}
const triVal = (k: keyof StyleProps) => (s[k] === undefined ? '' : String(s[k]));
function toggleBorder(side: string) {
  const cur: string = s.borders ?? '';
  s.borders = cur.includes(side) ? cur.replace(side, '') : cur + side;
}
</script>

<template>
  <div class="form-grid" style="grid-template-columns: 120px 1fr">
    <template v-if="!compact">
      <label>Font</label>
      <div class="row">
        <FontPicker width="100%" style="flex: 1" :model-value="s.fontFamily" placeholder="(inherit)" @update:model-value="set('fontFamily', $event)" />
        <input type="number" min="4" step="0.5" style="width: 64px" placeholder="size" :value="s.fontSize ?? ''" @change="set('fontSize', parseFloat(($event.target as HTMLInputElement).value))" />
      </div>
    </template>
    <label>Font style</label>
    <div class="row" style="flex-wrap: wrap">
      <label class="row">Bold <select :value="triVal('bold')" @change="tri('bold', $event)"><option value="">–</option><option value="true">Yes</option><option value="false">No</option></select></label>
      <label class="row">Italic <select :value="triVal('italic')" @change="tri('italic', $event)"><option value="">–</option><option value="true">Yes</option><option value="false">No</option></select></label>
      <label class="row">Underline <select :value="triVal('underline')" @change="tri('underline', $event)"><option value="">–</option><option value="true">Yes</option><option value="false">No</option></select></label>
      <label class="row">Strike <select :value="triVal('strike')" @change="tri('strike', $event)"><option value="">–</option><option value="true">Yes</option><option value="false">No</option></select></label>
    </div>
    <label>Fore color</label>
    <ColorInput :model-value="s.color" placeholder="(inherit)" @update:model-value="set('color', $event)" />
    <label>Back color</label>
    <ColorInput :model-value="s.backColor" placeholder="(inherit)" @update:model-value="set('backColor', $event)" />
    <template v-if="!compact">
      <label>Alignment</label>
      <div class="row">
        <select :value="s.textAlign ?? ''" @change="set('textAlign', ($event.target as HTMLSelectElement).value)">
          <option value="">(inherit)</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justify">Justify</option>
        </select>
        <select :value="s.vAlign ?? ''" @change="set('vAlign', ($event.target as HTMLSelectElement).value)">
          <option value="">(inherit)</option><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
        </select>
        <span>Padding</span>
        <input type="number" min="0" style="width: 60px" :value="s.padding ?? ''" placeholder="–" @change="set('padding', parseFloat(($event.target as HTMLInputElement).value))" />
      </div>
      <label>Borders</label>
      <div class="row">
        <div class="border-toggles">
          <button v-for="b in ['t', 'r', 'b', 'l']" :key="b" :class="{ on: (s.borders ?? '').includes(b) }" @click="toggleBorder(b)">{{ b.toUpperCase() }}</button>
          <button title="Inherit" @click="set('borders', undefined)">–</button>
        </div>
        <input type="number" min="0" step="0.5" style="width: 56px" placeholder="width" :value="s.borderWidth ?? ''" @change="set('borderWidth', parseFloat(($event.target as HTMLInputElement).value))" />
        <select :value="s.borderStyle ?? ''" @change="set('borderStyle', ($event.target as HTMLSelectElement).value)">
          <option value="">–</option><option value="solid">solid</option><option value="dashed">dashed</option><option value="dotted">dotted</option>
        </select>
      </div>
      <label>Border color</label>
      <ColorInput :model-value="s.borderColor" placeholder="(inherit)" @update:model-value="set('borderColor', $event)" />
    </template>
  </div>
</template>
