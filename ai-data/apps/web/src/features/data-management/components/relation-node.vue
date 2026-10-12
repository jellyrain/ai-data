<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import { Database, Plus, ChevronRight } from "lucide-vue-next";
import type { Dataset } from "@ai-data/contracts";
defineProps<{
  id: string;
  data: { dataset: Dataset; locked: boolean };
  selected?: boolean;
}>();
const emit = defineEmits<{ expand: []; create: [] }>();
</script>
<template>
  <article class="query-node relation-node" :class="{ 'is-selected': selected }">
    <Handle
      type="target"
      :position="Position.Left"
      :connectable="!data.locked"
      :aria-label="`${id} 连接终点`"
    />
    <div class="query-node-kicker">
      <Database :size="15" /><span>{{ data.dataset.kind === "view" ? "视图" : "数据表" }}</span>
    </div>
    <h3 :title="data.dataset.name">{{ data.dataset.name }}</h3>
    <p class="relation-node-id" :title="id">{{ id }}</p>
    <footer>
      <span>{{ data.dataset.columns.length }} 个字段</span
      ><button
        class="node-action nodrag"
        :aria-label="`展开 ${id} 关联`"
        title="展开该对象的全部关联"
        :disabled="data.locked"
        @click.stop="emit('expand')"
      >
        <ChevronRight :size="16" /></button
      ><button
        class="node-action nodrag"
        :aria-label="`从 ${id} 新建关系`"
        title="新建关系"
        :disabled="data.locked"
        @click.stop="emit('create')"
      >
        <Plus :size="16" />
      </button>
    </footer>
    <Handle
      type="source"
      :position="Position.Right"
      :connectable="!data.locked"
      :aria-label="`${id} 连接起点`"
    />
  </article>
</template>
