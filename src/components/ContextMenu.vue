<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { Check, ChevronRight } from 'lucide-vue-next';
import { closeContextMenu, ctxMenu, type MenuItem } from '../designer/ui';

const menu = ref<HTMLElement>();
const sub = ref<HTMLElement>();
const pos = ref({ x: 0, y: 0 });
const openSub = ref<number | null>(null);
const subPos = ref({ x: 0, y: 0 });

function run(it: MenuItem) {
  if (it.disabled || !it.action) return;
  closeContextMenu();
  it.action();
}

/** keep the menu fully on screen (it scrolls when taller than the window) */
watch(
  () => [ctxMenu.open, ctxMenu.items, ctxMenu.x, ctxMenu.y] as const,
  async () => {
    openSub.value = null;
    if (!ctxMenu.open) return;
    pos.value = { x: ctxMenu.x, y: ctxMenu.y };
    await nextTick();
    const el = menu.value;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = ctxMenu.x;
    let y = ctxMenu.y;
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8);
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    pos.value = { x, y };
  },
  { flush: 'post' },
);

async function showSub(i: number, e: MouseEvent) {
  const it = ctxMenu.items[i];
  if (!it?.children?.length || it.disabled) {
    openSub.value = null;
    return;
  }
  openSub.value = i;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  subPos.value = { x: r.right - 2, y: r.top - 4 };
  await nextTick();
  const s = sub.value;
  if (!s) return;
  let x = r.right - 2;
  let y = r.top - 4;
  if (x + s.offsetWidth > window.innerWidth - 8) x = Math.max(8, r.left - s.offsetWidth + 2);
  if (y + s.offsetHeight > window.innerHeight - 8) y = Math.max(8, window.innerHeight - s.offsetHeight - 8);
  subPos.value = { x, y };
}
</script>

<template>
  <div v-if="ctxMenu.open" ref="menu" class="ctx-menu" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @mousedown.stop @contextmenu.prevent>
    <template v-for="(it, i) in ctxMenu.items" :key="i">
      <div v-if="it.sep" class="menu-sep" />
      <div v-else-if="it.header" class="submenu-title">{{ it.header }}</div>
      <button
        v-else
        class="menu-item"
        :class="{ 'has-sub': it.children?.length, 'sub-open': openSub === i }"
        :disabled="it.disabled"
        @mouseenter="showSub(i, $event)"
        @click="it.children?.length ? showSub(i, $event) : run(it)"
      >
        <component :is="it.icon" v-if="it.icon" :size="14" />
        <Check v-else-if="it.checked" :size="14" />
        <span>{{ it.label }}</span>
        <span v-if="it.kbd" class="kbd">{{ it.kbd }}</span>
        <ChevronRight v-if="it.children?.length" :size="13" class="sub-caret" />
      </button>
    </template>
  </div>
  <div
    v-if="ctxMenu.open && openSub !== null && ctxMenu.items[openSub]?.children"
    ref="sub"
    class="ctx-menu ctx-submenu"
    :style="{ left: subPos.x + 'px', top: subPos.y + 'px' }"
    @mousedown.stop
    @contextmenu.prevent
  >
    <template v-for="(it, j) in ctxMenu.items[openSub].children" :key="j">
      <div v-if="it.sep" class="menu-sep" />
      <div v-else-if="it.header" class="submenu-title">{{ it.header }}</div>
      <button v-else class="menu-item" :disabled="it.disabled" @click="run(it)">
        <component :is="it.icon" v-if="it.icon" :size="14" />
        <Check v-else-if="it.checked" :size="14" />
        <span v-else class="menu-icon-space" />
        <span>{{ it.label }}</span>
        <span v-if="it.kbd" class="kbd">{{ it.kbd }}</span>
      </button>
    </template>
  </div>
</template>
