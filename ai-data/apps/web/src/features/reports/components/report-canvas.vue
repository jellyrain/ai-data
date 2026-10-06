<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import type { Connection, FlowEvents, NodeDragEvent, ViewportTransform } from "@vue-flow/core";
import { ElButton } from "element-plus";
import { Plus, MousePointer2, Hand, Scan, Sparkles, Minus } from "lucide-vue-next";
import type { ReportEditor } from "../stores/report-editor";
import type { QueryGraph } from "../models/query-graph-types";
import { graphForQuery, moveNode } from "../models/query-graph";
import QueryNode from "./query-node.vue";
import FlowingEdge from "./flowing-edge.vue";
import RelationPicker from "./relation-picker.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
const props = defineProps<{ editor: ReportEditor; queryId: string; aiOpen?: boolean }>();
const emit = defineEmits<{ add: []; inspect: [alias: string]; ai: [] }>();
const root = ref<HTMLElement>(),
  nodes = shallowRef<QueryGraph["nodes"]>([]),
  hand = ref(false),
  hidden = ref(document.hidden);
const viewport = ref<ViewportTransform>({ x: 0, y: 0, zoom: 1 });
const menu = ref<{ source: string; target?: string; x: number; y: number }>();
const graph = computed(() => graphForQuery(props.editor.state.draft, props.queryId));
const locked = computed(
  () => props.editor.state.locked || props.editor.state.saving || props.editor.state.uncertain,
);
const { fitView, zoomIn, zoomOut } = useVueFlow();
let fitted = false;
function initializeView() {
  if (!fitted && nodes.value.length) {
    fitted = true;
    void fitView({ maxZoom: 1, padding: 0.25 });
  }
}
let origin = "",
  connected = false,
  returnFocus: HTMLElement | null = null;
watch(
  graph,
  (value) => {
    nodes.value = value.nodes;
  },
  { immediate: true },
);
watch(
  () => props.queryId,
  async () => {
    closeMenu();
    await nextTick();
    void fitView({ padding: 0.25, maxZoom: 1 });
  },
);
function visibility() {
  hidden.value = document.hidden;
}
onMounted(() => document.addEventListener("visibilitychange", visibility));
onBeforeUnmount(() => document.removeEventListener("visibilitychange", visibility));
function moved(event: NodeDragEvent) {
  props.editor.update(moveNode(props.editor.state.draft, event.node.id, event.node.position));
}
function openMenu(source: string, target?: string, event?: MouseEvent | TouchEvent) {
  if (locked.value) return;
  const bounds = root.value?.getBoundingClientRect(),
    point = event && ("touches" in event ? event.changedTouches[0] : event);
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  menu.value = {
    source,
    target,
    x: Math.max(
      12,
      Math.min(point && bounds ? point.clientX - bounds.left : 300, (bounds?.width ?? 800) - 350),
    ),
    y: Math.max(
      12,
      Math.min(point && bounds ? point.clientY - bounds.top : 120, (bounds?.height ?? 700) - 420),
    ),
  };
  void nextTick(() =>
    root.value?.querySelector<HTMLElement>(".canvas-relation-menu button")?.focus(),
  );
}
function closeMenu() {
  menu.value = undefined;
  returnFocus?.focus();
}
function panePointerDown(event: PointerEvent) {
  // 下一次按下空白才关闭，拖线松开产生的 click 应保留刚打开的关系菜单。
  if (event.target instanceof Element && event.target.classList.contains("vue-flow__pane"))
    closeMenu();
}
function connectStart(event: FlowEvents["connectStart"]) {
  origin = event.handleType === "source" ? (event.nodeId ?? "") : "";
  connected = false;
}
function connect(connection: Connection) {
  connected = true;
  const source = nodes.value.find((n) => n.id === connection.source),
    target = nodes.value.find((n) => n.id === connection.target);
  if (source && target) openMenu(source.data!.alias, target.data!.alias);
}
function connectEnd(event: FlowEvents["connectEnd"]) {
  const source = nodes.value.find((n) => n.id === origin);
  if (!connected && source) openMenu(source.data!.alias, undefined, event);
  else if (connected && menu.value) openMenu(menu.value.source, menu.value.target, event);
  origin = "";
}
function relationAdded(alias: string) {
  closeMenu();
  emit("inspect", alias);
}
</script>
<template>
  <div
    ref="root"
    class="report-canvas"
    :class="{ 'canvas-pan': hand }"
    :style="{
      backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
      backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    }"
    @keydown.esc="closeMenu"
    @pointerdown.capture="panePointerDown"
  >
    <VueFlow
      v-model:nodes="nodes"
      :edges="graph.edges"
      :nodes-draggable="!locked && !hand"
      :nodes-connectable="!locked"
      :pan-on-drag="hand ? true : [1, 2]"
      :selection-on-drag="!hand"
      :delete-key-code="null"
      :min-zoom="0.15"
      :max-zoom="2"
      @nodes-initialized="initializeView"
      @node-drag-stop="moved"
      @connect-start="connectStart"
      @connect="connect"
      @connect-end="connectEnd"
      @viewport-change="viewport = $event"
      @node-double-click="emit('inspect', $event.node.data.alias)"
      @edge-click="emit('inspect', $event.edge.data.alias)"
      @node-context-menu="
        $event.event.preventDefault();
        emit('inspect', $event.node.data.alias);
      "
    >
      <template #node-query="node"
        ><QueryNode
          :data="node.data"
          :selected="node.selected"
          :locked="locked"
          @inspect="emit('inspect', node.data.alias)"
          @relation="openMenu(node.data.alias)"
      /></template>
      <template #edge-flowing="edge"><FlowingEdge v-bind="edge" :paused="hidden" /></template>
    </VueFlow>
    <div v-if="!nodes.length" class="canvas-empty">
      <span class="canvas-empty-symbol"><Plus :size="28" :stroke-width="1" /></span>
      <h2>从一个数据对象开始</h2>
      <p>添加查询，把数据与业务关系连接起来。</p>
      <ElButton type="primary" @click="emit('add')">添加第一个查询</ElButton>
    </div>
    <div
      v-if="menu"
      class="canvas-relation-menu canvas-floating"
      role="dialog"
      aria-label="选择批准关系"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
    >
      <RelationPicker
        :editor="editor"
        :query-id="queryId"
        :source-alias="menu.source"
        :target-alias="menu.target"
        @close="closeMenu"
        @connected="relationAdded"
      />
    </div>
    <div class="canvas-zoom canvas-floating">
      <button aria-label="缩小画布" title="缩小" @click="zoomOut()"><Minus :size="15" /></button
      ><span>{{ Math.round(viewport.zoom * 100) }}%</span
      ><button aria-label="放大画布" title="放大" @click="zoomIn()"><Plus :size="15" /></button>
    </div>
    <div class="canvas-tools canvas-floating" role="toolbar" aria-label="画布工具">
      <button
        class="canvas-add"
        aria-label="添加查询"
        title="添加查询"
        :disabled="locked"
        @click="emit('add')"
      >
        <Plus :size="22" /></button
      ><span class="toolbar-divider" /><button
        :aria-pressed="!hand"
        aria-label="选择模式"
        title="选择与拖动节点"
        @click="hand = false"
      >
        <MousePointer2 :size="18" /></button
      ><button :aria-pressed="hand" aria-label="平移模式" title="平移画布" @click="hand = true">
        <Hand :size="18" /></button
      ><button
        aria-label="适应画布"
        title="适应所有节点"
        @click="fitView({ padding: 0.25, maxZoom: 1 })"
      >
        <Scan :size="18" /></button
      ><span class="toolbar-divider" /><button
        :aria-pressed="aiOpen"
        aria-label="AI 修改"
        title="AI 修改报表"
        :disabled="!editor.state.baseline"
        @click="emit('ai')"
      >
        <Sparkles :size="19" />
      </button>
    </div>
    <span class="canvas-hint muted">{{ hand ? "拖动画布平移" : "拖动节点布局 · 双击配置" }}</span>
  </div>
</template>
