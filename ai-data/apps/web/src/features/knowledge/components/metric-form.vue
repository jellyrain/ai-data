<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton, ElInput, ElInputNumber, ElOption, ElSelect } from "element-plus";
import { stableStringify, type MetricDefinition } from "@ai-data/contracts";
import { metricQueryToEditor, editorQueryToMetric } from "../stores/metric-query-editing";
import { useServices } from "../../../app/services";
import { ReportEditor } from "../../reports/stores/report-editor";
import { queryFields } from "../../reports/models/query-editing";
import QueryEditor from "../../reports/components/query-editor.vue";
import DatasetPicker from "../../reports/components/dataset-picker.vue";
import RelationPicker from "../../reports/components/relation-picker.vue";
const props = defineProps<{ modelValue: MetricDefinition }>();
const emit = defineEmits<{ "update:modelValue": [MetricDefinition]; valid: [boolean] }>();
const { request, resources, auth } = useServices();
const editor = new ReportEditor({ request, resources, identity: () => auth.state.context });
const error = ref("");
const relations = computed(() =>
  Object.values(editor.state.relations).flatMap((graph) => graph.outgoing),
);
const choosing = ref(false),
  relation = ref<{ source: string; target?: string }>();
const item = computed(() => editor.state.draft.queries[0]);
const fields = computed(() =>
  item.value?.query.type === "relational_query"
    ? queryFields(item.value.query, editor.state.datasets[item.value.query.source_id] ?? [])
    : [],
);
function patch(change: Partial<MetricDefinition>) {
  emit("update:modelValue", { ...props.modelValue, ...change });
}
async function sync() {
  try {
    if (props.modelValue.query.joins.length)
      for (const object of [props.modelValue.query.from, ...props.modelValue.query.joins])
        await editor.loadRelations(props.modelValue.query.source_id, object.object_id);
    const query = metricQueryToEditor(props.modelValue.query, relations.value);
    if (!editor.state.ready) return;
    editor.update({
      title: props.modelValue.name || "指标查询",
      parameters: [],
      queries: [{ query_id: "metric", query, bindings: [] }],
      presentation: [],
      block_references: [],
    });
    error.value = "";
    emit("valid", true);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "查询无法读取";
    emit("valid", false);
  }
}
onMounted(async () => {
  await editor.open();
  await sync();
  await editor.loadSources();
});
watch(
  () => item.value?.query,
  (query) => {
    if (!query || query.type !== "relational_query") {
      emit("valid", false);
      return;
    }
    try {
      const next = editorQueryToMetric(query, relations.value);
      error.value = "";
      emit("valid", true);
      if (stableStringify(next) !== stableStringify(props.modelValue.query)) patch({ query: next });
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : "查询无法保存";
      emit("valid", false);
    }
  },
  { deep: true },
);
onBeforeUnmount(() => editor.dispose());
function added(id: string) {
  const query = editor.state.draft.queries.find((value) => value.query_id === id);
  if (query) editor.update({ ...editor.state.draft, queries: [query] });
  choosing.value = false;
}
</script>
<template>
  <p v-if="error" role="alert" class="inline-error">
    {{ error }}<ElButton text @click="sync">重新核对关联</ElButton>
  </p>
  <div class="management-form-grid">
    <label
      >指标标识<ElInput
        :model-value="modelValue.metric_id"
        aria-label="指标标识"
        @update:model-value="patch({ metric_id: String($event) })" /></label
    ><label
      >指标版本<ElInputNumber
        :model-value="modelValue.version"
        :min="1"
        :precision="0"
        aria-label="指标版本"
        @update:model-value="patch({ version: Number($event) })"
    /></label>
    <label
      >指标名称<ElInput
        :model-value="modelValue.name"
        aria-label="指标名称"
        @update:model-value="patch({ name: String($event) })" /></label
    ><label
      >统计粒度<ElInput
        :model-value="modelValue.grain"
        aria-label="统计粒度"
        placeholder="例如一次住院"
        @update:model-value="patch({ grain: String($event) })"
    /></label>
    <label class="wide"
      >统计口径<ElInput
        type="textarea"
        :rows="3"
        :model-value="modelValue.description"
        aria-label="统计口径"
        @update:model-value="patch({ description: String($event) })"
    /></label>
    <label class="wide"
      >常用别名（每行一个）<ElInput
        type="textarea"
        :model-value="modelValue.aliases.join('\n')"
        aria-label="指标别名"
        @update:model-value="
          patch({
            aliases: String($event)
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
          })
        "
    /></label>
  </div>
  <section class="management-section">
    <h3>基础查询</h3>
    <ElButton @click="choosing = !choosing">选择查询对象</ElButton
    ><DatasetPicker v-if="choosing" :editor="editor" @added="added" />
    <p v-if="item && item.query.type !== 'relational_query'" role="alert" class="inline-error">
      指标需要表或视图的关系查询，请重新选择查询对象。
    </p>
    <QueryEditor
      v-if="item?.query.type === 'relational_query'"
      :editor="editor"
      :query-id="item.query_id"
      @relation="(source, target) => (relation = { source, target })"
    /><RelationPicker
      v-if="relation && item"
      :editor="editor"
      :query-id="item.query_id"
      :source-alias="relation.source"
      :target-alias="relation.target"
      @connected="relation = undefined"
      @close="relation = undefined"
    />
    <p v-if="editor.state.catalogError" class="inline-error" role="alert">
      {{ editor.state.catalogError }}
    </p>
  </section>
  <section class="management-section">
    <h3>时间、去重与结果</h3>
    <div class="management-form-grid">
      <label
        >日期依据<ElSelect
          :model-value="modelValue.date_basis.field"
          filterable
          aria-label="指标日期字段"
          @update:model-value="
            patch({ date_basis: { ...modelValue.date_basis, field: String($event) } })
          "
          ><ElOption
            v-for="field in fields.filter((item) => ['date', 'datetime'].includes(item.dataType))"
            :key="field.name"
            :value="field.name"
            :label="field.label" /></ElSelect
      ></label>
      <label
        >日期类型<ElSelect
          :model-value="modelValue.date_basis.data_type"
          aria-label="指标日期类型"
          @update:model-value="
            patch({ date_basis: { ...modelValue.date_basis, data_type: $event } })
          "
          ><ElOption value="date" label="日期" /><ElOption
            value="datetime"
            label="日期时间" /></ElSelect
      ></label>
      <label
        >去重键<ElSelect
          :model-value="modelValue.deduplication_keys"
          multiple
          aria-label="指标去重键"
          @update:model-value="patch({ deduplication_keys: $event })"
          ><ElOption
            v-for="field in fields"
            :key="field.name"
            :value="field.name"
            :label="field.label" /></ElSelect
      ></label>
      <label
        >可用维度<ElSelect
          :model-value="modelValue.dimensions"
          multiple
          aria-label="指标维度"
          @update:model-value="patch({ dimensions: $event })"
          ><ElOption
            v-for="field in fields"
            :key="field.name"
            :value="field.name"
            :label="field.label" /></ElSelect
      ></label>
      <label
        >结果计算<ElSelect
          :model-value="modelValue.value.type"
          aria-label="指标计算方式"
          @update:model-value="
            patch({
              value:
                $event === 'ratio'
                  ? { type: 'ratio', numerator: '', denominator: '' }
                  : { type: 'column', column: '' },
            })
          "
          ><ElOption value="column" label="聚合列" /><ElOption
            value="ratio"
            label="分子 / 分母" /></ElSelect
      ></label>
      <label v-if="modelValue.value.type === 'column'"
        >结果列<ElSelect
          :model-value="modelValue.value.column"
          aria-label="指标结果列"
          @update:model-value="patch({ value: { type: 'column', column: String($event) } })"
          ><ElOption
            v-for="column in modelValue.query.select.filter((item) => item.as)"
            :key="column.as"
            :value="column.as!"
            :label="column.as!" /></ElSelect
      ></label>
      <template v-else
        ><label
          >分子列<ElSelect
            :model-value="modelValue.value.numerator"
            aria-label="指标分子"
            @update:model-value="
              patch({ value: { ...modelValue.value, numerator: String($event) } })
            "
            ><ElOption
              v-for="column in modelValue.query.select.filter((item) => item.as)"
              :key="column.as"
              :value="column.as!"
              :label="column.as!" /></ElSelect></label
        ><label
          >分母列<ElSelect
            :model-value="modelValue.value.denominator"
            aria-label="指标分母"
            @update:model-value="
              patch({ value: { ...modelValue.value, denominator: String($event) } })
            "
            ><ElOption
              v-for="column in modelValue.query.select.filter((item) => item.as)"
              :key="column.as"
              :value="column.as!"
              :label="column.as!" /></ElSelect></label
      ></template>
    </div>
    <p class="management-help">
      总计在完整授权范围重新计算；基础查询使用具名聚合列，执行时再选择分组。
    </p>
  </section>
</template>
