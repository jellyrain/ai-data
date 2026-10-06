<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElInput, ElPagination } from "element-plus";
const props = defineProps<{
  items: { id: string; title: string; description?: string; status?: string }[];
  selected?: string;
  disabled?: boolean;
}>();
defineEmits<{ select: [id: string] }>();
const search = ref("");
const page = ref(1);
const filtered = computed(() =>
  props.items.filter((item) =>
    `${item.title} ${item.id}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
  ),
);
const visible = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20));
watch(
  () => filtered.value.length,
  (length) => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 20)));
  },
);
</script>
<template>
  <aside class="management-list" aria-label="资源列表">
    <ElInput
      v-model="search"
      placeholder="搜索名称或标识"
      aria-label="搜索名称或标识"
      clearable
      @input="page = 1"
    />
    <p class="muted">{{ filtered.length }} 项</p>
    <div class="management-list-items">
      <button
        v-for="item in visible"
        :key="item.id"
        type="button"
        :disabled="disabled"
        :aria-pressed="selected === item.id"
        class="management-resource"
        @click="$emit('select', item.id)"
      >
        <span
          ><strong>{{ item.title }}</strong
          ><small>{{ item.id }}</small></span
        ><span class="management-resource-status">{{ item.status }}</span
        ><small v-if="item.description" class="management-resource-description">{{
          item.description
        }}</small>
      </button>
    </div>
    <p v-if="!filtered.length" class="muted">暂无匹配的资源。</p>
    <ElPagination
      v-if="filtered.length > 20"
      v-model:current-page="page"
      :page-size="20"
      :total="filtered.length"
      layout="prev, pager, next"
      size="small"
    />
  </aside>
</template>
