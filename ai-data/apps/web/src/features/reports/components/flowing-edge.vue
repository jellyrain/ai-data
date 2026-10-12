<script setup lang="ts">
import { computed } from "vue";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@vue-flow/core";
import type { EdgeProps } from "@vue-flow/core";
import type { QueryEdgeData } from "../models/query-graph-types";
const props = defineProps<EdgeProps<QueryEdgeData> & { paused?: boolean; bend?: number }>();
const path = computed(() => {
  if (!props.bend) return getBezierPath(props);
  const { sourceX: x1, sourceY: y1, targetX: x2, targetY: y2, bend } = props;
  const reach = Math.max(80, Math.abs(x2 - x1) / 2);
  return [
    `M ${x1},${y1} C ${x1 + reach},${y1 + bend} ${x2 - reach},${y2 + bend} ${x2},${y2}`,
    (x1 + x2) / 2,
    (y1 + y2) / 2 + bend * 0.75,
  ] as const;
});
const marker = computed(() => `arrow_${props.id}`);
</script>
<template>
  <g class="flowing-edge" :class="{ 'is-selected': selected, paused }">
    <defs
      ><marker
        :id="marker"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
        ><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--app-muted)" /></marker
    ></defs>
    <BaseEdge
      :id="id"
      :path="path[0]"
      :marker-end="`url(#${marker})`"
      class="relation-base"
      :interaction-width="22"
    />
    <!-- 三束光沿同一曲线循环，细分尾部渐隐；共用一层柔光，避免逐段创建滤镜。 -->
    <g v-if="animated !== false" class="relation-stream">
      <path
        v-for="segment in 14"
        :key="segment"
        :d="path[0]"
        pathLength="100"
        class="relation-light"
        :style="{
          '--trail': `${(segment - 1) * 0.55}px`,
          '--tail-width': 2.8 - (segment - 1) * 0.1,
          opacity: Math.pow(1 - (segment - 1) / 14, 1.6),
        }"
      />
      <path
        :d="path[0]"
        pathLength="100"
        class="relation-light relation-head"
        style="--trail: 0px"
      />
    </g>
  </g>
  <EdgeLabelRenderer
    ><div
      class="relation-label nodrag nopan"
      :data-edge-id="id"
      :class="{ 'is-selected': selected }"
      :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }"
    >
      <slot name="label"
        >{{ data.joinType.toUpperCase() }} <span>· {{ data.relationId }}</span></slot
      >
    </div></EdgeLabelRenderer
  >
</template>
