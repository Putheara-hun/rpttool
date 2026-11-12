<script setup lang="ts">
import { computed } from 'vue';
import { validate } from '../engine/expression';
import { editExpression } from '../store/designer';

const props = defineProps<{ modelValue?: string; placeholder?: string; title?: string }>();
const emit = defineEmits<{ 'update:modelValue': [v: string] }>();
const error = computed(() => validate(props.modelValue ?? ''));
async function openEditor() {
  const v = await editExpression(props.modelValue ?? '', props.title ?? 'Expression Editor');
  if (v !== null) emit('update:modelValue', v);
}
</script>

<template>
  <span class="row" style="gap: 3px; flex: 1; min-width: 0">
    <input
      type="text"
      style="flex: 1; height: 24px; font-size: 12px; font-family: Consolas, monospace; min-width: 0"
      :style="error ? { borderColor: 'var(--danger)' } : undefined"
      :title="error ?? modelValue ?? ''"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button class="fx-btn" title="Open expression editor" @click="openEditor">ƒ</button>
  </span>
</template>
