<script setup lang="ts">
import { computed } from 'vue';
import {
  Barcode,
  ChartColumn,
  FileText,
  Hash,
  Image,
  Lock,
  Minus,
  Rows3,
  Square,
  SquareCheck,
  Table,
  Table2,
  Type,
} from 'lucide-vue-next';
import { bandCaption } from '../model/defaults';
import { clearSelection, select, selectBand, state, visibleBands } from '../store/designer';
import type { ReportElement } from '../model/types';

const ICONS: Record<ReportElement['type'], any> = {
  text: Type,
  image: Image,
  line: Minus,
  shape: Square,
  barcode: Barcode,
  chart: ChartColumn,
  checkbox: SquareCheck,
  pageInfo: Hash,
  table: Table,
  crosstab: Table2,
};
const tree = computed(() =>
  visibleBands.value.map((b) => ({
    band: b,
    caption: bandCaption(state.report, b),
    els: state.report.elements.filter((e) => e.bandId === b.id),
  })),
);
const isSel = (id: string) => state.selection.includes(id);
function describe(e: ReportElement) {
  if (e.type === 'text') return e.expression || e.text;
  if (e.type === 'chart') return e.chartType;
  if (e.type === 'barcode') return e.symbology;
  return '';
}
</script>

<template>
  <div class="tree">
    <div class="tree-item" :class="{ sel: !state.selection.length && !state.selectedBandId }" @click="clearSelection()">
      <FileText :size="14" /> <b>{{ state.report.name || 'Report' }}</b>
    </div>
    <template v-for="t in tree" :key="t.band.id">
      <div class="tree-item" style="padding-left: 18px" :class="{ sel: state.selectedBandId === t.band.id }" @click="selectBand(t.band.id)">
        <Rows3 :size="14" /> {{ t.caption }}
        <span class="type">{{ t.els.length }}</span>
      </div>
      <div
        v-for="e in t.els"
        :key="e.id"
        class="tree-item"
        style="padding-left: 38px"
        :class="{ sel: isSel(e.id) }"
        @click="select([e.id], $event.ctrlKey || $event.shiftKey || $event.metaKey)"
      >
        <component :is="ICONS[e.type]" :size="13" />
        {{ e.name }}
        <Lock v-if="e.locked" :size="11" />
        <span class="type" style="max-width: 110px; overflow: hidden; text-overflow: ellipsis">{{ describe(e) }}</span>
      </div>
    </template>
  </div>
</template>
