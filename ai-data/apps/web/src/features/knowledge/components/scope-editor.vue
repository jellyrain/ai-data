<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { ElButton, ElSelect, ElOption } from "element-plus";
import type { MemoryScope, MetricDefinition } from "@ai-data/contracts";
import type { EditorField } from "../../reports/models/definition-editor-types";
import { ReportEditor } from "../../reports/stores/report-editor";
import { useServices } from "../../../app/services";
const props = defineProps<{ modelValue: MemoryScope; disabled?: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [MemoryScope];
  fields: [EditorField[]];
  metrics: [MetricDefinition[]];
}>();
const { request, resources, auth } = useServices();
const catalog = new ReportEditor({ request, resources, identity: () => auth.state.context });
const state = catalog.state;
const metric = computed(() =>
  state.metrics.find((item) => item.metric_id === props.modelValue.metric_id),
);
const source = computed(() => props.modelValue.source_id ?? metric.value?.query.source_id ?? "");
const object = computed(
  () => props.modelValue.object_id ?? metric.value?.query.from.object_id ?? "",
);
const datasets = computed(() => state.datasets[source.value] ?? []);
watch(
  source,
  (value) => {
    void catalog.loadDatasets(value);
  },
  { immediate: true },
);
watch(
  () => state.metrics,
  (value) => emit("metrics", value),
  { deep: true },
);
watch(
  () => datasets.value.find((item) => item.object_id === object.value),
  (dataset) => {
    emit(
      "fields",
      dataset?.columns.map((column) => ({
        name: column.name,
        label: column.source_description
          ? column.source_description + " · " + column.name
          : column.name,
        dataType: column.data_type,
        operators: dataset.query_capabilities?.filter_conditions?.find(
          (item) => item.name === column.name,
        )?.allowed_ops,
      })) ?? [],
    );
  },
  { immediate: true, deep: true },
);
onMounted(async () => {
  await catalog.open();
  await catalog.loadSources();
  await catalog.loadMetrics();
  if (source.value) await catalog.loadDatasets(source.value);
});
onBeforeUnmount(() => catalog.dispose());
function changeSource(value: string) {
  emit("update:modelValue", value ? { source_id: value } : {});
}
</script>
<template>
  <div class="management-form-grid">
    <label
      >数据源<ElSelect
        :model-value="modelValue.source_id ?? ''"
        clearable
        filterable
        :disabled="disabled"
        aria-label="适用数据源"
        @update:model-value="changeSource(String($event))"
        ><ElOption
          v-for="item in state.sources"
          :key="item.source_id"
          :label="item.source_id"
          :value="item.source_id" /></ElSelect
    ></label>
    <label
      >数据对象<ElSelect
        :model-value="modelValue.object_id ?? ''"
        clearable
        filterable
        :disabled="disabled || !modelValue.source_id"
        aria-label="适用数据对象"
        @update:model-value="
          emit(
            'update:modelValue',
            $event
              ? { source_id: modelValue.source_id, object_id: String($event) }
              : { source_id: modelValue.source_id },
          )
        "
        ><ElOption
          v-for="item in datasets"
          :key="item.object_id"
          :label="item.name"
          :value="item.object_id" /></ElSelect
    ></label>
    <label class="wide"
      >指标范围（可选）<ElSelect
        :model-value="modelValue.metric_id ?? ''"
        clearable
        filterable
        :disabled="disabled"
        aria-label="适用指标"
        @update:model-value="
          emit(
            'update:modelValue',
            $event
              ? { ...modelValue, metric_id: String($event) }
              : Object.fromEntries(
                  Object.entries(modelValue).filter(([key]) => key !== 'metric_id'),
                ),
          )
        "
        ><ElOption
          v-for="item in state.metrics"
          :key="item.metric_id + ':' + item.version"
          :label="item.name"
          :value="item.metric_id" /></ElSelect
    ></label>
  </div>
  <p class="management-help">范围留空时作为通用设置。字段条件需选择数据对象或指标。</p>
  <ElButton
    v-if="state.sourceCursor"
    text
    :loading="state.loadingSources"
    @click="catalog.loadSources(true)"
    >加载更多数据源</ElButton
  >
  <p v-if="state.catalogError" role="alert" class="inline-error">
    {{ state.catalogError
    }}<ElButton
      text
      @click="
        catalog.loadSources();
        catalog.loadMetrics();
        catalog.loadDatasets(source, true);
      "
      >重试目录</ElButton
    >
  </p>
</template>
