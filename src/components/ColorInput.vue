<script setup lang="ts">
import ColorPicker from './ColorPicker.vue';

const props = defineProps<{ modelValue?: string; placeholder?: string; clearable?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [v: string | undefined] }>();
const set = (v: string | undefined) => emit('update:modelValue', v === undefined || v.trim() === '' ? undefined : v.trim());
</script>

<template>
  <span class="row" style="gap: 3px; flex: 1; min-width: 0">
    <ColorPicker
      :model-value="modelValue"
      :placeholder="placeholder && placeholder !== 'none' ? placeholder : undefined"
      :allow-none="clearable !== false"
      @update:model-value="set"
    />
    <input
      type="text"
      style="flex: 1; height: 24px; font-size: 12px; min-width: 0; font-family: Consolas, monospace"
      :value="modelValue ?? ''"
      :placeholder="placeholder || 'none'"
      @change="set(($event.target as HTMLInputElement).value)"
    />
    <button v-if="clearable !== false && modelValue" class="reset-btn" title="Clear" @click="emit('update:modelValue', undefined)">×</button>
  </span>
</template>
