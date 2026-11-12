<script setup lang="ts">
import { computed } from 'vue';
import { state } from '../store/designer';
import DataSourceDialog from './DataSourceDialog.vue';
import GroupSortDialog from './GroupSortDialog.vue';
import ParametersDialog from './ParametersDialog.vue';
import CalcFieldsDialog from './CalcFieldsDialog.vue';
import PageSetupDialog from './PageSetupDialog.vue';
import StylesDialog from './StylesDialog.vue';
import FormatRulesDialog from './FormatRulesDialog.vue';
import WatermarkDialog from './WatermarkDialog.vue';
import WizardDialog from './WizardDialog.vue';
import AboutDialog from './AboutDialog.vue';
import DetailReportDialog from './DetailReportDialog.vue';
import SaveInfoDialog from './SaveInfoDialog.vue';

const MAP = {
  saveInfo: SaveInfoDialog,
  dataSources: DataSourceDialog,
  groupSort: GroupSortDialog,
  parameters: ParametersDialog,
  calcFields: CalcFieldsDialog,
  pageSetup: PageSetupDialog,
  styles: StylesDialog,
  formatRules: FormatRulesDialog,
  watermark: WatermarkDialog,
  wizard: WizardDialog,
  detailReports: DetailReportDialog,
  about: AboutDialog,
} as const;
const comp = computed(() => (state.dialog && state.dialog !== 'expression' ? MAP[state.dialog] : null));
</script>

<template>
  <component :is="comp" v-if="comp" :key="state.dialog ?? ''" />
</template>
