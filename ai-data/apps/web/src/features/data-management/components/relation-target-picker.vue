<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInput } from "element-plus";
import { Database, Search, X } from "lucide-vue-next";
import type { Dataset } from "@ai-data/contracts";
const props = defineProps<{ datasets: Dataset[]; source: string }>();
const emit = defineEmits<{ choose: [id: string]; close: [] }>();
const search = ref("");
const input = ref<InstanceType<typeof ElInput>>();
const matching = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return props.datasets.filter((item) =>
    `${item.name} ${item.object_id} ${item.source_description ?? ""}`
      .toLocaleLowerCase()
      .includes(query),
  );
});
onMounted(() => input.value?.focus());
</script>
<template>
  <section class="relation-target-picker" @keydown.esc.stop.prevent="emit('close')">
    <header class="editor-record-heading">
      <strong>选择关联表</strong>
      <ElButton text aria-label="关闭选表菜单" @click="emit('close')"><X :size="16" /></ElButton>
    </header>
    <p class="muted">
      {{ datasets.find((item) => item.object_id === source)?.name ?? source }} → 目标表
    </p>
    <ElInput
      ref="input"
      v-model="search"
      aria-label="搜索关联表"
      placeholder="搜索表名或注释"
      :prefix-icon="Search"
      clearable
    />
    <div class="relation-target-list">
      <button
        v-for="item in matching.slice(0, 100)"
        :key="item.object_id"
        type="button"
        :aria-label="`选择关联表 ${item.name} · ${item.object_id}`"
        @click="emit('choose', item.object_id)"
      >
        <Database :size="16" /><span
          ><strong>{{ item.name }}</strong
          ><small>{{ item.object_id }}</small></span
        >
        <small>{{ item.kind === "view" ? "视图" : "表" }}</small>
      </button>
      <p v-if="!matching.length" class="muted">没有匹配的表或视图。</p>
      <p v-else-if="matching.length > 100" class="muted">已显示前 100 项，请搜索定位更多对象。</p>
    </div>
  </section>
</template>
