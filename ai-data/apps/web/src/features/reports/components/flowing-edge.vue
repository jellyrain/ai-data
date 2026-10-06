<script setup lang="ts">
import { computed } from "vue";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@vue-flow/core";
import type { EdgeProps } from "@vue-flow/core";
import type { QueryEdgeData } from "../models/query-graph-types";
const props = defineProps<EdgeProps<QueryEdgeData> & { paused?: boolean }>();
const path = computed(() => getBezierPath(props));
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
        ><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--app-primary)" /></marker
    ></defs>
    <BaseEdge
      :id="id"
      :path="path[0]"
      :marker-end="`url(#${marker})`"
      class="relation-base"
      :interaction-width="22"
    />
    <!-- 各段共用实际曲线路径与归一化长度，头部向终点运动，尾段依次淡出。 -->
    <path
      v-for="segment in 7"
      :key="segment"
      :d="path[0]"
      pathLength="100"
      class="relation-light"
      :style="{ '--trail': (segment - 1) * 1.3, opacity: 1 - (segment - 1) / 7 }"
    />
  </g>
  <EdgeLabelRenderer
    ><div
      class="relation-label nodrag nopan"
      :class="{ 'is-selected': selected }"
      :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }"
    >
      {{ data.joinType.toUpperCase() }} <span>· {{ data.relationId }}</span>
    </div></EdgeLabelRenderer
  >
</template>
