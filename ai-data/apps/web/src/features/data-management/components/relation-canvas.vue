<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  VueFlow,
  useVueFlow,
  type Connection,
  type Node,
  type Edge,
  type NodeDragEvent,
  type ViewportTransform,
} from "@vue-flow/core";
import type { Dataset } from "@ai-data/contracts";
import { Plus, MousePointer2, Hand, Scan, Minus, Zap } from "lucide-vue-next";
import { useCanvasNavigation } from "../../../shared/canvas/use-canvas-navigation";
import { useCanvasMotion } from "../../../shared/canvas/use-canvas-motion";
import { useCanvasMenu } from "../../../shared/canvas/use-canvas-menu";
import CanvasContextMenu from "../../../shared/canvas/canvas-context-menu.vue";
import type { CanvasMenuAction } from "../../../shared/canvas/canvas-menu-types";
import FlowingEdge from "../../reports/components/flowing-edge.vue";
import type { QueryEdgeData } from "../../reports/models/query-graph-types";
import type { RelationView, RelationPreview } from "../stores/relation-draft-types";
import { useRelationConnection } from "../stores/use-relation-connection";
import { layoutRelations } from "../stores/relation-layout";
import RelationNode from "./relation-node.vue";
import RelationTargetPicker from "./relation-target-picker.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
const props = defineProps<{
  datasets: Dataset[];
  objects: string[];
  relations: RelationView[];
  positions: Record<string, { x: number; y: number }>;
  selected: string;
  locked: boolean;
  preview?: RelationPreview;
}>();
const emit = defineEmits<{
  connect: [connection: Connection, position?: { x: number; y: number }];
  edit: [key: string];
  create: [object: string];
  expand: [object: string];
  move: [id: string, position: { x: number; y: number }];
  picker: [open?: boolean];
}>();
const root = ref<HTMLElement>(),
  hand = ref(false),
  hidden = ref(document.hidden);
const viewport = ref<ViewportTransform>({ x: 0, y: 0, zoom: 1 });
const navigation = useCanvasNavigation(root),
  motion = useCanvasMotion();
const context = useCanvasMenu(root);
const { fitView, zoomIn, zoomOut, dimensions, project } = useVueFlow();
const connection = useRelationConnection(
  root,
  () => props.locked || hand.value,
  (value, point) => emit("connect", value, point ? project(point) : undefined),
);
const nodes = shallowRef<Node[]>([]);
const visibleObjects = computed(() => [
  ...new Set([
    ...props.objects,
    ...(props.preview ? [props.preview.source, props.preview.target] : []),
  ]),
]);
const displayed = computed(() =>
  props.relations.filter(
    (row) =>
      visibleObjects.value.includes(row.relation.object_id) &&
      visibleObjects.value.includes(row.relation.target_object_id),
  ),
);
const defaultPositions = computed(() =>
  layoutRelations(visibleObjects.value, [
    ...displayed.value
      .filter((view) => view.key !== props.preview?.key)
      .map((view) => view.relation),
    ...(props.preview
      ? [{ object_id: props.preview.source, target_object_id: props.preview.target }]
      : []),
  ]),
);
watch(
  () =>
    [defaultPositions.value, props.datasets, props.positions, props.locked, hand.value] as const,
  () => {
    nodes.value = visibleObjects.value.map((id) => {
      const dataset = props.datasets.find((item) => item.object_id === id) ?? {
        source_id: "",
        object_id: id,
        name: id,
        kind: "table",
        columns: [],
        query_parameters: [],
      };
      return {
        id,
        type: "relation",
        position: props.positions[id] ?? defaultPositions.value.get(id)!,
        data: { dataset, locked: props.locked || hand.value },
      };
    });
  },
  { immediate: true },
);
const edges = computed<Edge<QueryEdgeData>[]>(() =>
  displayed.value
    .filter((view) => view.key !== props.preview?.key)
    .map((view, index) => {
      const row = view.relation;
      return {
        id: `business_relation_${index}`,
        source: row.object_id,
        target: row.target_object_id,
        selected: view.key === props.selected,
        type: "flowing",
        class: `relation-state-${view.change ?? (row.enabled ? "published" : "disabled")}`,
        data: { alias: view.key, relationId: row.relation_id, joinType: row.cardinality ?? "" },
      };
    }),
);
const canvasEdges = computed<Edge<QueryEdgeData>[]>(() =>
  props.preview
    ? [
        ...edges.value,
        {
          id: "business_relation_preview",
          source: props.preview.source,
          target: props.preview.target,
          type: "preview",
          selected: true,
          class: "relation-state-preview",
          data: {
            alias: "",
            relationId: "",
            joinType: "",
          },
        },
      ]
    : edges.value,
);
const contextNode = computed(() =>
  nodes.value.find((node) => node.id === context.current.value?.node),
);
const contextEdge = computed(() =>
  edges.value.find((edge) => edge.id === context.current.value?.edge),
);
const contextActions = computed<CanvasMenuAction[]>(() => [
  ...(contextNode.value
    ? [
        { id: "create", label: "新建出向关系", disabled: props.locked },
        { id: "expand", label: "展开全部关联", disabled: props.locked },
        { id: "focus", label: "聚焦节点" },
      ]
    : contextEdge.value
      ? [
          { id: "edit", label: "编辑关系" },
          { id: "source", label: "聚焦源对象" },
          { id: "target", label: "聚焦目标对象" },
        ]
      : [{ id: "add", label: "添加对象", disabled: props.locked }]),
  { id: "fit", label: "适应所有节点" },
  { id: "hand", label: "平移模式", checked: hand.value },
  { id: "motion", label: "连线动效", checked: motion.enabled.value },
]);
function contextAction(id: string) {
  const node = contextNode.value,
    edge = contextEdge.value;
  if (id === "create" && node) connection.open(node.id);
  else if (id === "expand" && node) emit("expand", node.id);
  else if (id === "focus" && node) void fitView({ nodes: [node.id], maxZoom: 1, padding: 0.5 });
  else if (id === "edit" && edge?.data) emit("edit", edge.data.alias);
  else if ((id === "source" || id === "target") && edge)
    void fitView({
      nodes: [id === "source" ? edge.source : edge.target],
      maxZoom: 1,
      padding: 0.5,
    });
  else if (id === "add") emit("picker", true);
  else if (id === "fit") fit();
  else if (id === "hand") hand.value = !hand.value;
  else if (id === "motion") motion.toggle();
}
function label(key: string) {
  const row = displayed.value.find((item) => item.key === key)!;
  const status =
    row.change === "create"
      ? "新增"
      : row.change === "update"
        ? "待更新"
        : row.change === "disable"
          ? "待停用"
          : !row.relation.enabled
            ? "已停用"
            : "";
  return `${row.relation.description || row.relation.relation_id}${status ? ` · ${status}` : ""}`;
}
function bend(key: string) {
  const view = displayed.value.find((item) => item.key === key)!;
  const peers = displayed.value.filter(
    (item) =>
      item.relation.object_id === view.relation.object_id &&
      item.relation.target_object_id === view.relation.target_object_id,
  );
  return peers.length > 1
    ? (peers.findIndex((item) => item.key === key) - (peers.length - 1) / 2) * 100
    : 0;
}
function moved(event: NodeDragEvent) {
  emit("move", event.node.id, { ...event.node.position });
}
function fit() {
  void fitView({ padding: 0.22, maxZoom: 1 });
}
let fitted = false;
watch(
  () => visibleObjects.value.length,
  () => {
    fitted = false;
  },
);
function initialized() {
  if (!fitted && nodes.value.length) {
    fitted = true;
    fit();
  }
}
watch(() => [dimensions.value.width, dimensions.value.height], fit, { flush: "post" });
watch(
  () => props.locked,
  (locked) => {
    if (locked) connection.close();
  },
);
function visibility() {
  hidden.value = document.hidden;
}
onMounted(() => document.addEventListener("visibilitychange", visibility));
onBeforeUnmount(() => document.removeEventListener("visibilitychange", visibility));
defineExpose({ fit });
</script>
<template>
  <div
    ref="root"
    class="report-canvas relation-canvas"
    :class="{ 'canvas-pan': hand || navigation.panning.value }"
    :style="{
      backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
      backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    }"
    @pointerdown.capture="
      navigation.down($event);
      connection.paneDown($event);
    "
    @pointermove.capture="navigation.move"
    @pointerup.capture="navigation.up"
    @pointercancel="navigation.finish"
    @lostpointercapture="navigation.finish"
    @mousedown.capture="navigation.mouseDown"
    @contextmenu.capture="context.open"
    @click.capture="navigation.click"
  >
    <VueFlow
      v-model:nodes="nodes"
      :edges="canvasEdges"
      :nodes-draggable="!locked && !hand"
      :nodes-connectable="!locked && !hand"
      :pan-on-drag="hand ? [0, 1] : [1]"
      :selection-on-drag="!hand"
      multi-selection-key-code="Shift"
      :delete-key-code="null"
      :min-zoom="0.15"
      :max-zoom="2"
      @nodes-initialized="initialized"
      @node-drag-stop="moved"
      @viewport-change="viewport = $event"
      @connect-start="connection.start"
      @connect="connection.complete"
      @connect-end="connection.end"
      @edge-click="$event.edge.type !== 'preview' && emit('edit', $event.edge.data.alias)"
      @node-double-click="emit('create', $event.node.id)"
    >
      <template #node-relation="node"
        ><RelationNode
          v-bind="node"
          @expand="emit('expand', node.id)"
          @create="connection.open(node.id)"
      /></template>
      <template #edge-flowing="edge"
        ><FlowingEdge
          v-bind="edge"
          :bend="bend(edge.data.alias)"
          :animated="
            motion.enabled.value &&
            !!displayed.find((item) => item.key === edge.data.alias)?.relation.enabled
          "
          :paused="hidden"
          ><template #label
            ><button
              type="button"
              :aria-label="`编辑关系 ${displayed.find((item) => item.key === edge.data.alias)?.relation.description}`"
              @click.stop="emit('edit', edge.data.alias)"
            >
              {{ label(edge.data.alias) }}
            </button></template
          ></FlowingEdge
        ></template
      >
      <template #edge-preview="edge">
        <FlowingEdge
          v-bind="edge"
          :animated="motion.enabled.value"
          :paused="hidden"
          :bend="
            edges.some((item) => item.source === edge.source && item.target === edge.target)
              ? 100
              : 0
          "
        >
          <template #label
            ><span>{{ preview?.description || "待配置关系" }} · 待应用</span></template
          >
        </FlowingEdge>
      </template>
    </VueFlow>
    <div
      v-if="connection.menu.value"
      class="canvas-relation-menu canvas-floating"
      role="dialog"
      aria-label="选择关联表"
      :style="{ left: `${connection.menu.value.x}px`, top: `${connection.menu.value.y}px` }"
    >
      <RelationTargetPicker
        :datasets="datasets"
        :source="connection.menu.value.source"
        @choose="connection.choose"
        @close="connection.close"
      />
    </div>
    <div class="canvas-tools canvas-floating" role="toolbar" aria-label="关系画布工具">
      <button
        class="canvas-add"
        aria-label="显示对象列表"
        title="添加数据对象"
        @click="emit('picker')"
      >
        <Plus :size="22" /></button
      ><span class="toolbar-divider" />
      <button
        aria-label="选择模式"
        :aria-pressed="!hand"
        title="选择与拖动节点"
        @click="hand = false"
      >
        <MousePointer2 :size="18" />
      </button>
      <button aria-label="平移模式" :aria-pressed="hand" title="平移画布" @click="hand = true">
        <Hand :size="18" />
      </button>
      <button aria-label="适应画布" title="适应所有节点" @click="fit"><Scan :size="18" /></button>
      <button
        aria-label="连线动效"
        :aria-pressed="motion.enabled.value"
        :title="motion.enabled.value ? '关闭连线动效' : '开启连线动效'"
        @click="motion.toggle"
      >
        <Zap :size="18" />
      </button>
    </div>
    <div class="canvas-zoom canvas-floating">
      <button aria-label="缩小画布" @click="zoomOut()"><Minus :size="15" /></button
      ><span>{{ Math.round(viewport.zoom * 100) }}%</span
      ><button aria-label="放大画布" @click="zoomIn()"><Plus :size="15" /></button>
    </div>
    <span class="relation-canvas-count muted"
      >{{ visibleObjects.length }} 个对象 · {{ displayed.length }} 条关系<span v-if="preview">
        · 正在配置</span
      ></span
    >
    <span class="canvas-hint muted">Ctrl + 拖动平移 · 右键菜单</span>
    <CanvasContextMenu
      :point="context.current.value?.point"
      :items="contextActions"
      @close="context.close"
      @action="contextAction"
    />
  </div>
</template>
