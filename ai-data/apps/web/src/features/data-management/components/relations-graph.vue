<script setup lang="ts">
import { computed, watch } from "vue";
import { VueFlow, Position, useVueFlow } from "@vue-flow/core";
import type { Node, Edge } from "@vue-flow/core";
import type { RelationGraph } from "@ai-data/contracts";
import FlowingEdge from "../../reports/components/flowing-edge.vue";
import type { QueryEdgeData } from "../../reports/models/query-graph-types";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
const props = defineProps<{ graph: RelationGraph }>();
const { fitView, dimensions } = useVueFlow();
function fitGraph() {
  void fitView({ padding: 0.25, maxZoom: 1 });
}
// 只读关系图在容器尺寸和节点集合变化后重新适配，保证新发布的端点完整可见。
watch(() => [dimensions.value.width, dimensions.value.height], fitGraph, { flush: "post" });
const relations = computed(() =>
  [...props.graph.incoming, ...props.graph.outgoing].filter((row) => row.enabled),
);
const nodes = computed<Node[]>(() =>
  [
    ...new Set([
      props.graph.object_id,
      ...relations.value.flatMap((row) => [row.object_id, row.target_object_id]),
    ]),
  ].map((id, index) => ({
    id,
    data: { label: id },
    position:
      index === 0
        ? { x: 300, y: 120 }
        : { x: index % 2 ? 0 : 600, y: Math.floor((index - 1) / 2) * 140 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  })),
);
const edges = computed<Edge<QueryEdgeData>[]>(() =>
  relations.value.map((row, index) => ({
    id: `management_relation_${index}`,
    source: row.object_id,
    target: row.target_object_id,
    type: "flowing",
    data: { relationId: row.relation_id, joinType: row.cardinality ?? "关联", alias: "" },
  })),
);
</script>
<template>
  <div class="management-relation-graph report-canvas" aria-label="已发布关系方向图">
    <VueFlow
      :nodes="nodes"
      :edges="edges"
      :nodes-connectable="false"
      :nodes-draggable="false"
      :edges-updatable="false"
      fit-view-on-init
      :min-zoom="0.2"
      :max-zoom="1.5"
      @nodes-initialized="fitGraph"
      ><template #edge-flowing="edge"><FlowingEdge v-bind="edge" /></template
    ></VueFlow>
  </div>
</template>
