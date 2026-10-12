<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useZIndex } from "element-plus";
import { Check } from "lucide-vue-next";
import type { CanvasMenuAction } from "./canvas-menu-types";
const props = defineProps<{ point?: { x: number; y: number }; items: CanvasMenuAction[] }>();
const emit = defineEmits<{ action: [id: string]; close: [] }>();
const menu = ref<HTMLElement>(),
  position = ref({ left: "0px", top: "0px", zIndex: 0 });
const { nextZIndex } = useZIndex();
let previousFocus: HTMLElement | null = null;
watch(
  () => props.point,
  async (point) => {
    if (!point) return;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    position.value = { left: `${point.x}px`, top: `${point.y}px`, zIndex: nextZIndex() };
    await nextTick();
    const bounds = menu.value?.getBoundingClientRect();
    position.value.left = `${Math.max(8, Math.min(point.x, innerWidth - (bounds?.width ?? 200) - 8))}px`;
    position.value.top = `${Math.max(8, Math.min(point.y, innerHeight - (bounds?.height ?? 280) - 8))}px`;
    menu.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  },
);
function close() {
  emit("close");
  previousFocus?.focus();
}
function choose(item: CanvasMenuAction) {
  if (item.disabled) return;
  emit("action", item.id);
  close();
}
function key(event: KeyboardEvent) {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [
    ...(menu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
  ];
  const index = buttons.findIndex((button) => button === document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
function outside(event: PointerEvent) {
  if (props.point && !menu.value?.contains(event.target as Node)) emit("close");
}
function resize() {
  if (props.point) emit("close");
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", resize);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", resize);
});
</script>
<template>
  <div
    v-if="point"
    ref="menu"
    class="canvas-context-menu"
    role="menu"
    aria-label="画布操作"
    :style="position"
    @keydown.stop="key"
    @contextmenu.prevent
  >
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
      :aria-checked="item.checked"
      :disabled="item.disabled"
      @click="choose(item)"
    >
      <span><Check v-if="item.checked" :size="14" /></span>{{ item.label }}
    </button>
  </div>
</template>
<style scoped>
.canvas-context-menu {
  position: fixed;
  width: 208px;
  max-width: calc(100vw - 16px);
  padding: 6px;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  box-shadow: 0 3px 8px #00000018;
}
.canvas-context-menu button {
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text);
  text-align: left;
  padding: 6px 10px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.canvas-context-menu button > span {
  width: 14px;
  flex-shrink: 0;
  color: var(--app-primary);
}
.canvas-context-menu button:hover,
.canvas-context-menu button:focus-visible {
  background: var(--app-primary-soft);
  outline: none;
}
.canvas-context-menu button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
