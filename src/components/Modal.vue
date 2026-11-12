<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { onMounted, ref } from 'vue';

defineProps<{ title: string; width?: number; height?: number }>();
const emit = defineEmits<{ close: [] }>();
const root = ref<HTMLElement>();
onMounted(() => {
  const first = root.value?.querySelector<HTMLElement>('[autofocus], input, textarea, select');
  first?.focus();
});
</script>

<template>
  <div class="modal-backdrop" @keydown.esc.stop="emit('close')">
    <div ref="root" class="modal" :style="{ width: (width ?? 640) + 'px', height: height ? height + 'px' : undefined }">
      <div class="modal-head">
        <slot name="icon" />
        <span>{{ title }}</span>
        <button class="icon-btn x" title="Close" @click="emit('close')"><X :size="16" /></button>
      </div>
      <div class="modal-body"><slot /></div>
      <div v-if="$slots.footer" class="modal-foot"><slot name="footer" /></div>
    </div>
  </div>
</template>
