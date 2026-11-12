<script setup lang="ts">
import { Keyboard } from 'lucide-vue-next';
import Modal from '../components/Modal.vue';
import { closeDialog } from '../store/designer';

const keys: [string, string][] = [
  ['Ctrl+S / Ctrl+Shift+S', 'Save / Save as'],
  ['Ctrl+O', 'Open report file'],
  ['Ctrl+Alt+N', 'New report'],
  ['F5', 'Toggle designer / preview'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
  ['Ctrl+C / X / V', 'Copy / Cut / Paste'],
  ['Ctrl+D', 'Duplicate selection'],
  ['Ctrl+A', 'Select all controls in the band'],
  ['Delete', 'Delete selection (or the selected band)'],
  ['Arrow keys', 'Move 1px (Ctrl: one grid step)'],
  ['Shift+Arrow keys', 'Resize 1px'],
  ['Shift/Ctrl+Click', 'Add to / remove from selection'],
  ['Alt while dragging', 'Disable grid & snap lines'],
  ['Double-click', 'Edit text in place / open expression editor'],
  ['Ctrl+Mouse wheel', 'Zoom the design surface'],
  ['Esc', 'Cancel tool / clear selection'],
];
</script>

<template>
  <Modal title="ReportTool — Shortcuts & Help" :width="780" @close="closeDialog">
    <template #icon><Keyboard :size="16" /></template>
    <div class="split">
      <div style="flex: 1">
        <div class="section-title" style="margin-top: 0">Keyboard &amp; mouse</div>
        <table class="data-table">
          <tbody>
            <tr v-for="[k, d] in keys" :key="k">
              <td><kbd>{{ k }}</kbd></td>
              <td>{{ d }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style="flex: 1; font-size: 12.5px; line-height: 1.55">
        <div class="section-title" style="margin-top: 0">How reports work</div>
        <p>A report is made of <b>bands</b>: Report Header/Footer print once, Page Header/Footer on every page, the <b>Detail</b> band once per data row, and Group Header/Footer bands around each group.</p>
        <p>Bind a label with an <b>Expression</b> such as <code>[Amount]</code>, or embed expressions in static text: <code>Total: {Sum([Amount])}</code>.</p>
        <p>Aggregates (<code>Sum, Count, Avg, Min, Max, CountDistinct</code>) work over the current group in group bands, all rows in report bands and the current page in page bands. Set <b>Summary Running</b> for running totals in the detail band.</p>
        <p>Use <b>Format String</b> for numbers and dates: <code>n2</code>, <code>c</code>, <code>p0</code>, <code>yyyy-MM-dd</code>, <code>#,##0.00</code>.</p>
        <p>
          Reports are saved as <code>.rptx</code> files and auto-saved in the browser. Save ▾ also saves as <b>HTML</b> (the printed report with data, opens in
          any browser) or <b>RDL</b> (SQL Server Reporting Services / Report Builder). Both keep the design inside, so ReportTool can open them again.
        </p>
      </div>
    </div>
    <template #footer>
      <button class="btn primary" @click="closeDialog">Close</button>
    </template>
  </Modal>
</template>
