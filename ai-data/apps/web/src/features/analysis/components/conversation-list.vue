<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput, ElCheckbox, ElDialog } from "element-plus";
import { Plus, Search, MessageSquare, Trash2 } from "lucide-vue-next";
import type { Conversation } from "../api/analysis-types";
const emit = defineEmits<{ navigate: []; create: []; retry: []; delete: [ids: string[]] }>();
const props = defineProps<{
  items: Conversation[];
  current?: string;
  error: string;
  deleting?: boolean;
}>();
const search = ref("");
const count = ref(50);
const selecting = ref(false);
const selected = ref<string[]>([]);
const pending = ref<string[]>([]);
const confirming = ref(false);
const filtered = computed(() =>
  props.items.filter((item) =>
    (item.title || "新分析").toLowerCase().includes(search.value.trim().toLowerCase()),
  ),
);
const displayed = computed(() => filtered.value.slice(0, count.value));
const allSelected = computed(
  () =>
    displayed.value.length > 0 && displayed.value.every((item) => selected.value.includes(item.id)),
);
watch(search, () => {
  count.value = 50;
  selected.value = [];
});
watch(
  () => props.items,
  (items) => {
    selected.value = selected.value.filter((id) => items.some((item) => item.id === id));
  },
);
function choose(id: string, checked: boolean) {
  selected.value = selected.value.filter((value) => value !== id);
  if (checked) selected.value.push(id);
}
function chooseAll(checked: boolean) {
  const ids = new Set(displayed.value.map((item) => item.id));
  selected.value = checked
    ? [...new Set([...selected.value, ...ids])]
    : selected.value.filter((id) => !ids.has(id));
}
function confirm(ids: string[]) {
  pending.value = [...ids];
  confirming.value = true;
}
function remove() {
  confirming.value = false;
  emit("delete", pending.value);
}
</script>
<template>
  <nav class="conversation-list" aria-label="分析会话">
    <ElButton type="primary" class="new-analysis" @click="$emit('create')"
      ><Plus :size="16" />新建分析</ElButton
    >
    <div class="conversation-list-heading">
      <h2>最近会话</h2>
      <ElButton
        text
        size="small"
        :disabled="deleting"
        @click="
          selecting = !selecting;
          selected = [];
        "
        >{{ selecting ? "完成" : "多选" }}</ElButton
      >
    </div>
    <ElInput v-model="search" aria-label="筛选会话" placeholder="搜索会话"
      ><template #prefix><Search :size="15" /></template
    ></ElInput>
    <div v-if="selecting" class="conversation-selection">
      <ElCheckbox
        :model-value="allSelected"
        :indeterminate="!allSelected && selected.length > 0"
        :disabled="deleting"
        @change="chooseAll(Boolean($event))"
        >全选</ElCheckbox
      >
      <ElButton
        text
        type="danger"
        :loading="deleting"
        :disabled="!selected.length || selected.length > 100"
        @click="confirm(selected)"
        >删除 {{ selected.length }} 项</ElButton
      >
      <small v-if="selected.length > 100" class="muted">每批最多删除 100 项，请减少选择。</small>
    </div>
    <p v-if="error" class="inline-error">
      {{ error }}<ElButton text @click="$emit('retry')">重新读取</ElButton>
    </p>
    <p v-else-if="!filtered.length" class="muted conversation-empty">
      {{ search ? "没有匹配的会话" : "从一个问题开始，你的分析会保存在这里。" }}
    </p>
    <div class="conversation-links">
      <div v-for="item in displayed" :key="item.id" class="conversation-row">
        <ElCheckbox
          v-if="selecting"
          :model-value="selected.includes(item.id)"
          :aria-label="`选择会话 ${item.title || '新分析'}`"
          :disabled="deleting"
          @change="choose(item.id, Boolean($event))"
        />
        <RouterLink
          :key="item.id"
          :to="`/analysis/${encodeURIComponent(item.id)}`"
          :class="{ selected: current === item.id }"
          :aria-current="current === item.id ? 'page' : undefined"
          @click="$emit('navigate')"
          ><MessageSquare :size="15" /><span>{{ item.title || "新分析" }}</span></RouterLink
        >
        <ElButton
          v-if="!selecting"
          text
          class="conversation-delete"
          :aria-label="`删除会话 ${item.title || '新分析'}`"
          :disabled="deleting"
          @click="confirm([item.id])"
          ><Trash2 :size="14"
        /></ElButton>
      </div>
    </div>
    <ElButton v-if="filtered.length > count" text @click="count += 50">显示更多会话</ElButton>
    <ElDialog v-model="confirming" title="删除会话" width="min(420px, 92vw)" append-to-body>
      <p>确认删除 {{ pending.length }} 个会话？删除后将从工作台移除，已保存的报表继续保留。</p>
      <template #footer
        ><ElButton @click="confirming = false">取消</ElButton
        ><ElButton type="danger" @click="remove"
          >确认删除 {{ pending.length }} 项</ElButton
        ></template
      >
    </ElDialog>
  </nav>
</template>
