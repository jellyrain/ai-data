<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElInput } from "element-plus";
import { Plus, Search, MessageSquare } from "lucide-vue-next";
import type { Conversation } from "../api/analysis-types";
defineEmits<{ navigate: []; create: []; retry: [] }>();
const props = defineProps<{ items: Conversation[]; current?: string; error: string }>();
const search = ref("");
const count = ref(50);
const filtered = computed(() =>
  props.items.filter((item) =>
    (item.title || "新分析").toLowerCase().includes(search.value.trim().toLowerCase()),
  ),
);
</script>
<template>
  <nav class="conversation-list" aria-label="分析会话">
    <ElButton type="primary" class="new-analysis" @click="$emit('create')"
      ><Plus :size="16" />新建分析</ElButton
    >
    <h2>最近会话</h2>
    <ElInput v-model="search" aria-label="筛选会话" placeholder="搜索会话"
      ><template #prefix><Search :size="15" /></template
    ></ElInput>
    <p v-if="error" class="inline-error">
      {{ error }}<ElButton text @click="$emit('retry')">重新读取</ElButton>
    </p>
    <p v-else-if="!filtered.length" class="muted conversation-empty">
      {{ search ? "没有匹配的会话" : "从一个问题开始，你的分析会保存在这里。" }}
    </p>
    <div class="conversation-links">
      <RouterLink
        v-for="item in filtered.slice(0, count)"
        :key="item.id"
        :to="`/analysis/${encodeURIComponent(item.id)}`"
        :class="{ selected: current === item.id }"
        :aria-current="current === item.id ? 'page' : undefined"
        @click="$emit('navigate')"
        ><MessageSquare :size="15" /><span>{{ item.title || "新分析" }}</span></RouterLink
      >
    </div>
    <ElButton v-if="filtered.length > count" text @click="count += 50">显示更多会话</ElButton>
  </nav>
</template>
