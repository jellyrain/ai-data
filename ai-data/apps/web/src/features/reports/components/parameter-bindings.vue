<script setup lang="ts">
import { computed, ref } from "vue";
import { ElSelect, ElOption } from "element-plus";
import type {
  Dataset,
  ReportDefinition,
  ReportParameter,
  ReportParameterBinding,
} from "@ai-data/contracts";
import BindingEditor from "./binding-editor.vue";
const props = defineProps<{
  modelValue: ReportDefinition;
  parameter: ReportParameter;
  datasets: Record<string, Dataset[]>;
}>();
const emit = defineEmits<{ "update:modelValue": [value: ReportDefinition] }>();
const extraQuery = ref("");
const bound = (bindings: ReportParameterBinding[]) =>
  bindings.some((binding) => binding.parameter === props.parameter.name);
const queries = computed(() =>
  props.modelValue.queries.filter(
    (query) => bound(query.bindings) || query.query_id === extraQuery.value,
  ),
);
const remaining = computed(() =>
  props.modelValue.queries.filter(
    (query) => !bound(query.bindings) && query.query_id !== extraQuery.value,
  ),
);
function update(queryId: string, bindings: ReportParameterBinding[]) {
  emit("update:modelValue", {
    ...props.modelValue,
    queries: props.modelValue.queries.map((query) =>
      query.query_id === queryId ? { ...query, bindings } : query,
    ),
  });
}
</script>
<template>
  <div class="condition-bindings">
    <details
      v-for="(query, queryIndex) in queries"
      :key="query.query_id"
      class="condition-query-binding"
      :open="queryIndex === 0"
    >
      <summary class="condition-query-label">
        查询 {{ query.query_id }}
        <span
          >{{
            query.bindings.filter((binding) => binding.parameter === parameter.name).length
          }}
          处关联</span
        >
      </summary>
      <BindingEditor
        :model-value="query.bindings"
        :parameter-name="parameter.name"
        :parameters="modelValue.parameters"
        :query="query.query"
        :datasets="
          query.query.type === 'metric_query' ? [] : (datasets[query.query.source_id] ?? [])
        "
        @update:model-value="update(query.query_id, $event)"
      />
    </details>
    <ElSelect
      v-if="remaining.length"
      v-model="extraQuery"
      :aria-label="`${parameter.label}关联查询`"
      :placeholder="queries.length ? '关联其他查询…' : '选择此条件作用的查询…'"
      class="condition-add-query"
      ><ElOption
        v-for="query in remaining"
        :key="query.query_id"
        :value="query.query_id"
        :label="query.query_id"
    /></ElSelect>
    <p v-if="!modelValue.queries.length" class="muted">添加数据查询后，可在这里关联字段。</p>
  </div>
</template>
