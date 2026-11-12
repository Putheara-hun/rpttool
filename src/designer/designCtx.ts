import { computed } from 'vue';
import type { EvalContext } from '../engine/expression';
import { compileCalcFields, paramValues } from '../engine/renderer';
import { mainRows, state } from '../store/designer';

/** Evaluation context used for design-time rendering (charts, cross tabs show real data). */
export const designCtx = computed<EvalContext>(() => {
  const rows = mainRows.value;
  return {
    row: rows[0] ?? null,
    rows,
    params: paramValues(state.report, state.paramValues),
    calc: compileCalcFields(state.report),
    reportName: state.report.name,
    fmt: { locale: state.report.locale || 'en-US', currency: state.report.currency || 'USD' },
  };
});
