<script setup lang="ts">
import {
  Barcode,
  Calendar,
  ChartColumn,
  Circle,
  Hash,
  Image,
  Minus,
  MousePointer2,
  QrCode,
  SeparatorVertical,
  Square,
  SquareCheck,
  Table,
  Table2,
  TextCursorInput,
  Type,
} from 'lucide-vue-next';
import { notify, state } from '../store/designer';
import type { ToolId } from '../model/defaults';

const groups: { title: string; items: { id: ToolId | null; label: string; icon: any }[] }[] = [
  { title: 'Pointer', items: [{ id: null, label: 'Pointer', icon: MousePointer2 }] },
  {
    title: 'Text & Data',
    items: [
      { id: 'text', label: 'Label', icon: Type },
      { id: 'field', label: 'Data Field', icon: TextCursorInput },
      { id: 'table', label: 'Table', icon: Table },
      { id: 'checkbox', label: 'Check Box', icon: SquareCheck },
    ],
  },
  {
    title: 'Graphics',
    items: [
      { id: 'image', label: 'Picture Box', icon: Image },
      { id: 'hline', label: 'Horizontal Line', icon: Minus },
      { id: 'vline', label: 'Vertical Line', icon: SeparatorVertical },
      { id: 'shape', label: 'Rectangle', icon: Square },
      { id: 'ellipse', label: 'Ellipse', icon: Circle },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { id: 'chart', label: 'Chart', icon: ChartColumn },
      { id: 'crosstab', label: 'Cross Tab (Pivot)', icon: Table2 },
      { id: 'barcode', label: 'Barcode', icon: Barcode },
      { id: 'qr', label: 'QR Code', icon: QrCode },
    ],
  },
  {
    title: 'Page Info',
    items: [
      { id: 'pageNofM', label: 'Page Number', icon: Hash },
      { id: 'dateInfo', label: 'Date / Time', icon: Calendar },
    ],
  },
];

function pick(id: ToolId | null) {
  state.tool = state.tool === id ? null : id;
  if (state.tool) notify('Click inside a band to place the control, or drag it onto the page');
}
function onDragStart(e: DragEvent, id: ToolId | null) {
  if (!id || !e.dataTransfer) return;
  e.dataTransfer.setData('text/x-rt-tool', id);
  e.dataTransfer.effectAllowed = 'copy';
}
</script>

<template>
  <div class="toolbox">
    <template v-for="g in groups" :key="g.title">
      <div class="tool-group">{{ g.title }}</div>
      <div
        v-for="it in g.items"
        :key="it.label"
        class="tool"
        :class="{ active: state.tool === it.id }"
        :draggable="!!it.id"
        :title="it.id ? 'Click, then click on a band — or drag onto the page' : 'Select / move controls'"
        @click="pick(it.id)"
        @dragstart="onDragStart($event, it.id)"
      >
        <component :is="it.icon" :size="16" />
        <span>{{ it.label }}</span>
      </div>
    </template>
    <div class="empty-hint">Tip: drag fields from the <b>Field List</b> tab directly onto a band to create data-bound labels.</div>
  </div>
</template>
