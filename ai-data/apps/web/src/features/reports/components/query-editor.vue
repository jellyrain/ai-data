<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput, ElInputNumber, ElSelect, ElOption, ElMessageBox } from "element-plus";
import type { ReportQueryItem, ReportDefinition } from "@ai-data/contracts";
import type { ReportEditor } from "../stores/report-editor";
import type { RelationalReportQuery, FilterGroup } from "../models/definition-editor-types";
import {
  cloneDefinition,
  renameQuery,
  renameAlias,
  removeQuery,
} from "../models/definition-editor";
import { queryFields, removeObject } from "../models/query-editing";
import ConditionEditor from "./condition-editor.vue";
import BindingEditor from "./binding-editor.vue";
import TypedValue from "./typed-value.vue";
import PreAggregateEditor from "./pre-aggregate-editor.vue";
import IdentifierInput from "./identifier-input.vue";
import QuerySourceEditor from "./query-source-editor.vue";
const props = defineProps<{ editor: ReportEditor; queryId: string; alias?: string }>();
const emit = defineEmits<{
  relation: [alias: string, targetAlias?: string];
  renamed: [id: string];
  removed: [];
  aliasSelected: [alias: string];
}>();
const error = ref(""),
  selectedAlias = ref("");
const item = computed(() =>
  props.editor.state.draft.queries.find((q) => q.query_id === props.queryId),
);
const query = computed(() => item.value?.query);
const datasets = computed(() =>
  query.value && query.value.type !== "metric_query"
    ? (props.editor.state.datasets[query.value.source_id] ?? [])
    : [],
);
const fields = computed(() =>
  query.value?.type === "relational_query" ? queryFields(query.value, datasets.value) : [],
);
const objects = computed(() =>
  query.value?.type === "relational_query" ? [query.value.from, ...query.value.joins] : [],
);
const object = computed(
  () => objects.value.find((o) => o.alias === selectedAlias.value) ?? objects.value[0],
);
const join = computed(() =>
  query.value?.type === "relational_query"
    ? query.value.joins.find((j) => j.alias === object.value?.alias)
    : undefined,
);
const rawFields = computed(() =>
  query.value?.type === "relational_query" && object.value
    ? queryFields(query.value, datasets.value, object.value.alias, true)
    : [],
);
const onFields = computed(() => {
  const aliases = objects.value
    .slice(0, objects.value.findIndex((o) => o.alias === object.value?.alias) + 1)
    .map((o) => o.alias);
  return fields.value.filter((f) => aliases.includes(f.name.split(".")[0]!));
});
const parameterDataset = computed(() => {
  const q = query.value;
  return q?.type === "parameterized_query"
    ? datasets.value.find((d) => d.object_id === q.from.object_id)
    : undefined;
});
const metric = computed(() => {
  const q = query.value;
  if (q?.type !== "metric_query") return undefined;
  const metrics = props.editor.state.metrics
    .filter((m) => m.metric_id === q.metric_id)
    .sort((a, b) => b.version - a.version);
  return q.version ? metrics.find((m) => m.version === q.version) : metrics[0];
});
const aggregations = {
  count: "计数",
  count_distinct: "去重计数",
  sum: "求和",
  avg: "平均",
  min: "最小",
  max: "最大",
};
watch(
  () => [props.queryId, props.alias],
  () => {
    selectedAlias.value = props.alias ?? objects.value[0]?.alias ?? "";
    error.value = "";
  },
  { immediate: true },
);
watch(
  () => {
    const q = query.value;
    return q?.type === "metric_query"
      ? JSON.stringify([q.type, q.metric_id, q.version])
      : q?.source_id;
  },
  () => {
    const q = query.value;
    if (!q) return;
    if (q.type === "metric_query") void props.editor.loadMetric(q.metric_id, q.version);
    else void props.editor.loadDatasets(q.source_id);
  },
  { immediate: true },
);
function edit(operation: (value: ReportQueryItem) => void) {
  const definition = cloneDefinition(props.editor.state.draft),
    current = definition.queries.find((q) => q.query_id === props.queryId);
  if (!current) return;
  operation(current);
  props.editor.update(definition);
}
function change(value: ReportQueryItem["query"]) {
  edit((item) => {
    item.query = value;
  });
}
function objectChange(
  change: Partial<RelationalReportQuery["from"]> & { on_filters?: FilterGroup },
) {
  edit((item) => {
    if (item.query.type !== "relational_query") return;
    const target = [item.query.from, ...item.query.joins].find(
      (o) => o.alias === object.value?.alias,
    );
    if (target) Object.assign(target, change);
  });
}
function run(operation: () => ReportDefinition) {
  try {
    props.editor.update(operation());
    error.value = "";
    return true;
  } catch (failure) {
    error.value = (failure as Error).message;
    return false;
  }
}
function changeId(id: string) {
  if (run(() => renameQuery(props.editor.state.draft, props.queryId, id))) emit("renamed", id);
}
function changeAlias(alias: string) {
  if (!object.value) return;
  if (run(() => renameAlias(props.editor.state.draft, props.queryId, object.value!.alias, alias))) {
    selectedAlias.value = alias;
    emit("aliasSelected", alias);
  }
}
async function remove(all: boolean) {
  const title = all ? "删除查询" : "移除关联对象";
  try {
    await ElMessageBox.confirm(
      all
        ? "移除该查询及展示引用？涉及的固定块将解除引用。"
        : "移除该对象、依赖它的后续关联和字段条件？请随后检查展示字段。",
      title,
      { confirmButtonText: "移除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  if (
    run(() =>
      all
        ? removeQuery(props.editor.state.draft, props.queryId)
        : removeObject(props.editor.state.draft, props.queryId, object.value!.alias),
    )
  ) {
    if (all) emit("removed");
    else selectedAlias.value = objects.value[0]?.alias ?? "";
  }
}
function inputParameter(
  name: string,
  data_type: NonNullable<typeof parameterDataset.value>["query_parameters"][number]["data_type"],
  value: unknown,
) {
  edit((item) => {
    if (item.query.type !== "parameterized_query") return;
    item.query.parameters = item.query.parameters.filter((p) => p.name !== name);
    if (value !== undefined) item.query.parameters.push({ name, data_type, value });
  });
}
</script>
<template>
  <section v-if="item && query" class="query-editor">
    <header class="editor-section-heading">
      <h2>查询配置</h2>
      <ElButton text type="danger" @click="remove(true)">删除查询</ElButton>
    </header>
    <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
    <p v-if="editor.state.catalogError" role="alert" class="inline-error">
      {{ editor.state.catalogError }}
    </p>
    <label
      >查询标识<IdentifierInput
        :model-value="item.query_id"
        label="查询标识"
        @change="changeId(String($event))"
    /></label>
    <QuerySourceEditor v-if="query.type !== 'metric_query'" :editor="editor" :query-id="queryId" />
    <template v-if="query.type === 'relational_query'">
      <p class="muted">数据源 {{ query.source_id }}</p>
      <div class="query-object-selector">
        <label
          >对象<ElSelect
            v-model="selectedAlias"
            aria-label="当前查询对象"
            @update:model-value="emit('aliasSelected', String($event))"
            ><ElOption
              v-for="candidate in objects"
              :key="candidate.alias"
              :value="candidate.alias"
              :label="`${candidate.alias} · ${candidate.object_id}`" /></ElSelect></label
        ><ElButton v-if="object" @click="emit('relation', object.alias)">添加关联</ElButton>
      </div>
      <section v-if="object" class="editor-record">
        <div class="editor-record-heading">
          <strong>{{ object.object_id }}</strong
          ><ElButton v-if="join" text type="danger" @click="remove(false)">移除对象</ElButton>
        </div>
        <label
          >对象别名<IdentifierInput
            :model-value="object.alias"
            label="对象别名"
            @change="changeAlias(String($event))"
        /></label>
        <p v-if="join" class="muted">
          {{ join.source_alias }} → {{ join.alias }} · {{ join.type.toUpperCase() }} ·
          {{ join.relation_id }}
          <ElButton text @click="emit('relation', join.source_alias, join.alias)"
            >查看批准关系</ElButton
          >
        </p>
        <details>
          <summary>对象预过滤与预聚合</summary>
          <ConditionEditor
            :model-value="object.filters"
            :fields="rawFields"
            label="对象预过滤"
            @update:model-value="objectChange({ filters: $event })"
          /><PreAggregateEditor
            :model-value="object.pre_aggregate"
            :fields="rawFields"
            @update:model-value="objectChange({ pre_aggregate: $event })"
          />
        </details>
        <details v-if="join">
          <summary>ON 附加条件</summary>
          <ConditionEditor
            :model-value="join.on_filters"
            :fields="onFields"
            label="ON 条件"
            @update:model-value="objectChange({ on_filters: $event })"
          />
        </details>
      </section>
      <section class="editor-subsection">
        <header class="editor-record-heading">
          <h3>输出字段</h3>
          <ElButton
            :disabled="!fields.length"
            @click="
              change({
                ...query,
                select: [
                  ...query.select,
                  { field: fields[0]!.name, as: `column_${query.select.length + 1}` },
                ],
              })
            "
            >添加字段</ElButton
          >
        </header>
        <div v-for="(column, index) in query.select" :key="index" class="editor-record">
          <div class="editor-grid">
            <label
              >字段<ElSelect
                :model-value="column.field"
                filterable
                :aria-label="`输出字段${index + 1}`"
                @update:model-value="
                  change({
                    ...query,
                    select: query.select.map((c, i) =>
                      i === index ? { ...c, field: String($event) } : c,
                    ),
                  })
                "
                ><ElOption
                  v-for="field in fields"
                  :key="field.name"
                  :value="field.name"
                  :label="field.label" /></ElSelect></label
            ><label
              >聚合<ElSelect
                :model-value="column.aggregation ?? ''"
                :aria-label="`输出聚合${index + 1}`"
                placeholder="原始字段"
                @update:model-value="
                  change({
                    ...query,
                    select: query.select.map((c, i) =>
                      i === index ? { ...c, aggregation: $event || undefined } : c,
                    ),
                  })
                "
                ><ElOption label="原始字段" value="" /><ElOption
                  v-for="(label, fn) in aggregations"
                  :key="fn"
                  :value="fn"
                  :label="label" /></ElSelect
            ></label>
          </div>
          <div class="editor-row">
            <label
              >输出名称<ElInput
                :model-value="column.as ?? ''"
                :placeholder="column.field.replaceAll('.', '_')"
                :aria-label="`输出名称${index + 1}`"
                @update:model-value="
                  change({
                    ...query,
                    select: query.select.map((c, i) =>
                      i === index ? { ...c, as: String($event) || undefined } : c,
                    ),
                  })
                " /></label
            ><ElButton
              text
              @click="change({ ...query, select: query.select.filter((_, i) => i !== index) })"
              >移除字段</ElButton
            >
          </div>
        </div>
      </section>
      <label
        >分组字段<ElSelect
          :model-value="query.group_by"
          multiple
          filterable
          aria-label="查询分组字段"
          @update:model-value="change({ ...query, group_by: $event })"
          ><ElOption
            v-for="field in fields"
            :key="field.name"
            :value="field.name"
            :label="field.label" /></ElSelect
      ></label>
      <ConditionEditor
        :model-value="query.filters"
        :fields="fields"
        label="查询筛选"
        @update:model-value="change({ ...query, filters: $event })"
      />
      <details>
        <summary>排序与行数</summary>
        <div v-for="(order, index) in query.order_by" :key="index" class="editor-row">
          <ElSelect
            :model-value="order.field"
            filterable
            :aria-label="`排序字段${index + 1}`"
            @update:model-value="
              change({
                ...query,
                order_by: query.order_by.map((o, i) =>
                  i === index ? { ...o, field: String($event) } : o,
                ),
              })
            "
            ><ElOption
              v-for="field in fields"
              :key="field.name"
              :value="field.name"
              :label="field.label" /></ElSelect
          ><ElSelect
            :model-value="order.direction"
            :aria-label="`排序方向${index + 1}`"
            @update:model-value="
              change({
                ...query,
                order_by: query.order_by.map((o, i) =>
                  i === index ? { ...o, direction: $event } : o,
                ),
              })
            "
            ><ElOption label="升序" value="asc" /><ElOption label="降序" value="desc" /></ElSelect
          ><ElButton
            text
            @click="change({ ...query, order_by: query.order_by.filter((_, i) => i !== index) })"
            >移除排序</ElButton
          >
        </div>
        <ElButton
          :disabled="!fields.length"
          @click="
            change({
              ...query,
              order_by: [...query.order_by, { field: fields[0]!.name, direction: 'asc' }],
            })
          "
          >添加排序</ElButton
        ><label
          >最多返回行数<ElInputNumber
            :model-value="query.limit"
            :min="1"
            :max="100000"
            aria-label="查询行数上限"
            @update:model-value="change({ ...query, limit: $event ?? undefined })"
        /></label>
      </details>
    </template>
    <template v-else-if="query.type === 'parameterized_query'"
      ><p class="muted">{{ query.source_id }} · {{ query.from.object_id }}</p>
      <label v-for="parameter in parameterDataset?.query_parameters ?? []" :key="parameter.name"
        >{{ parameter.source_description || parameter.name }}{{ parameter.required ? " · 必填" : ""
        }}<TypedValue
          :model-value="query.parameters.find((p) => p.name === parameter.name)?.value"
          :data-type="parameter.data_type"
          :label="parameter.name"
          :allow-array="false"
          @update:model-value="inputParameter(parameter.name, parameter.data_type, $event)"
      /></label>
      <p class="muted">固定输出：{{ parameterDataset?.columns.map((c) => c.name).join("、") }}</p>
      <label
        >最多返回行数<ElInputNumber
          :model-value="query.limit"
          :min="1"
          :max="100000"
          @update:model-value="change({ ...query, limit: $event ?? undefined })" /></label
    ></template>
    <template v-else
      ><h3>{{ metric?.name ?? query.metric_id }}</h3>
      <p class="muted">{{ metric?.description }}</p>
      <div class="editor-grid">
        <label
          >固定版本（留空使用当前版本）<ElInputNumber
            :model-value="query.version"
            :min="1"
            aria-label="指标版本"
            @update:model-value="change({ ...query, version: $event ?? undefined })" /></label
        ><label
          >结果类型<ElSelect
            :model-value="query.output"
            aria-label="指标结果类型"
            @update:model-value="change({ ...query, output: $event })"
            ><ElOption label="按维度分组" value="grouped" /><ElOption
              label="总计"
              value="total" /></ElSelect></label
        ><label
          >开始日期<ElInput
            :model-value="query.start"
            aria-label="指标开始日期"
            @update:model-value="change({ ...query, start: String($event) })" /></label
        ><label
          >结束日期<ElInput
            :model-value="query.end"
            aria-label="指标结束日期"
            @update:model-value="change({ ...query, end: String($event) })"
        /></label>
      </div>
      <label
        >统计维度<ElSelect
          :model-value="query.dimensions"
          multiple
          filterable
          aria-label="指标维度"
          @update:model-value="change({ ...query, dimensions: $event })"
          ><ElOption
            v-for="dimension in metric?.dimensions ?? []"
            :key="dimension"
            :value="dimension"
            :label="dimension" /></ElSelect></label
    ></template>
    <BindingEditor
      :model-value="item.bindings"
      :parameters="editor.state.draft.parameters"
      :query="query"
      :datasets="datasets"
      @update:model-value="
        edit((item) => {
          item.bindings = $event;
        })
      "
    />
  </section>
</template>
