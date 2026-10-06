<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import { Database, ChartNoAxesCombined, SlidersHorizontal, Plus } from "lucide-vue-next";
import type { QueryNodeData } from "../models/query-graph-types";
defineProps<{ data: QueryNodeData; selected?: boolean; locked?: boolean }>();
const emit = defineEmits<{ inspect: []; relation: [] }>();
</script>
<template>
  <article class="query-node" :class="{ 'is-selected': selected }">
    <Handle
      v-if="data.kind === 'relational_query'"
      type="target"
      :position="Position.Left"
      :connectable="!locked"
      :aria-label="`${data.alias} 连接终点`"
    />
    <div class="query-node-kicker">
      <component
        :is="data.kind === 'metric_query' ? ChartNoAxesCombined : Database"
        :size="15"
      /><span>{{
        data.kind === "metric_query"
          ? "指标查询"
          : data.kind === "parameterized_query"
            ? "参数化数据集"
            : data.primary
              ? "主对象"
              : "关联对象"
      }}</span
      ><code>{{ data.alias }}</code>
    </div>
    <h3 :title="data.objectId">{{ data.objectId }}</h3>
    <div class="query-node-fields">
      <span v-for="field in data.columns.slice(0, 4)" :key="field">{{ field }}</span
      ><span v-if="data.columns.length > 4" class="muted"
        >还有 {{ data.columns.length - 4 }} 个字段</span
      ><span v-if="!data.columns.length" class="muted">{{
        data.kind === "relational_query" ? "选择输出字段" : "在属性中配置查询"
      }}</span>
    </div>
    <footer>
      <span class="muted">{{ data.columns.length }} 个输出 · {{ data.conditions }} 个条件</span
      ><button
        class="node-action nodrag"
        type="button"
        :aria-label="`配置 ${data.alias}`"
        title="配置属性"
        @click.stop="emit('inspect')"
      >
        <SlidersHorizontal :size="15" /></button
      ><button
        v-if="data.kind === 'relational_query'"
        class="node-action nodrag"
        type="button"
        :disabled="locked"
        :aria-label="`关联 ${data.alias}`"
        title="添加关联"
        @click.stop="emit('relation')"
      >
        <Plus :size="16" />
      </button>
    </footer>
    <Handle
      v-if="data.kind === 'relational_query'"
      type="source"
      :position="Position.Right"
      :connectable="!locked"
      :aria-label="`${data.alias} 连接起点`"
    />
  </article>
</template>
