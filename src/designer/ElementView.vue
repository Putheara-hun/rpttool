<script setup lang="ts">
import { computed } from 'vue';
import type { BandType, ReportElement } from '../model/types';
import { layoutElement } from '../engine/layout';
import { fontEpoch } from '../engine/fonts';
import { escXml, primsToSvg } from '../export/svg';
import { rowsFor, state } from '../store/designer';
import { designCtx } from './designCtx';

const props = defineProps<{ el: ReportElement; left: number; bandType: BandType; selected: boolean; dragging: boolean; dsId?: string | null }>();

/** controls inside a detail report section use that section's data (charts, cross tabs) */
const ctx = computed(() => {
  if (!props.dsId) return designCtx.value;
  const rows = rowsFor(props.dsId);
  return { ...designCtx.value, rows, row: rows[0] ?? null };
});

const svg = computed(() => {
  void fontEpoch.value; // re-measure when a web font has finished loading
  try {
    const r = layoutElement(props.el, { report: state.report, ctx: ctx.value, design: true, bandType: props.bandType });
    return primsToSvg(r.prims);
  } catch (e) {
    return `<text x="2" y="12" font-size="11" fill="#dc2626">${escXml((e as Error).message)}</text>`;
  }
});
</script>

<template>
  <div
    class="el"
    :class="{ sel: selected, locked: el.locked, dragging }"
    :data-el-id="el.id"
    :title="el.name"
    :style="{ left: left + 'px', top: el.y + 'px', width: el.width + 'px', height: el.height + 'px' }"
  >
    <svg :width="el.width" :height="el.height" v-html="svg" />
  </div>
</template>
