<script setup lang="ts">
import { ref } from "vue";
import { ElInput, ElSelect, ElOption, ElCheckbox } from "element-plus";
import type {
  UserPreferenceInput,
  UserPreferenceValue,
  MetricDefinition,
} from "@ai-data/contracts";
import type { EditorField, FilterCondition } from "../../reports/models/definition-editor-types";
import ScopeEditor from "../../knowledge/components/scope-editor.vue";
import TimeRangeEditor from "./time-range-editor.vue";
import TypedValue from "../../reports/components/typed-value.vue";
import { ElButton } from "element-plus";
const props = defineProps<{ modelValue: UserPreferenceInput; existing?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [UserPreferenceInput] }>();
const fields = ref<EditorField[]>([]),
  metrics = ref<MetricDefinition[]>([]);
const types = {
  metric: "常用指标",
  time_range: "时间范围",
  filters: "筛选条件",
  grouping: "分组",
  presentation: "展示方式",
  query_habit: "查询习惯",
};
const operations = {
  eq: "等于",
  neq: "不等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  in: "属于",
  not_in: "不属于",
  between: "范围",
  is_null: "为空",
  not_null: "不为空",
  like: "匹配",
};
function value(next: UserPreferenceValue) {
  emit("update:modelValue", { ...props.modelValue, value: next });
}
function changeType(type: string) {
  const defaults: Record<string, UserPreferenceValue> = {
    metric: { type: "metric", metric_id: "" },
    time_range: {
      type: "time_range",
      range: { type: "relative", period: "this_year", extent: "full_period" },
    },
    filters: { type: "filters", conditions: [] },
    grouping: { type: "grouping", fields: [] },
    presentation: { type: "presentation", format: "table" },
    query_habit: { type: "query_habit", filters: [], dimensions: [] },
  };
  value(defaults[type]!);
}
function conditions() {
  const v = props.modelValue.value;
  return v.type === "filters" ? v.conditions : v.type === "query_habit" ? v.filters : [];
}
function setConditions(items: FilterCondition[]) {
  const v = props.modelValue.value;
  if (v.type === "filters") value({ ...v, conditions: items });
  else if (v.type === "query_habit") value({ ...v, filters: items });
}
function patch(index: number, next?: FilterCondition) {
  const items = conditions().slice();
  if (next) items[index] = next;
  else items.splice(index, 1);
  setConditions(items);
}
function fieldChange(index: number, name: string) {
  const field = fields.value.find((f) => f.name === name);
  if (field) patch(index, { field: name, op: "eq", data_type: field.dataType, value: null });
}
function addCondition() {
  const field = fields.value[0];
  if (field)
    setConditions([
      ...conditions(),
      { field: field.name, data_type: field.dataType, op: "eq", value: null },
    ]);
}
function changeOp(index: number, item: FilterCondition, op: FilterCondition["op"]) {
  const next = { ...item, op };
  if (op === "is_null" || op === "not_null") delete next.value;
  else
    next.value = ["in", "not_in", "between"].includes(op)
      ? [null, ...(op === "between" ? [null] : [])]
      : null;
  patch(index, next);
}
</script>
<template>
  <div class="management-form-grid">
    <label
      >偏好标识<ElInput
        :model-value="modelValue.key"
        :disabled="existing"
        maxlength="128"
        aria-label="偏好标识"
        placeholder="例如 default-time"
        @update:model-value="emit('update:modelValue', { ...modelValue, key: String($event) })"
    /></label>
    <label
      >偏好类型<ElSelect
        :model-value="modelValue.value.type"
        aria-label="偏好类型"
        @update:model-value="changeType(String($event))"
        ><ElOption v-for="(label, key) in types" :key="key" :value="key" :label="label" /></ElSelect
    ></label>
  </div>
  <section class="management-section">
    <h3>适用范围</h3>
    <ScopeEditor
      :model-value="modelValue.scope"
      @update:model-value="emit('update:modelValue', { ...modelValue, scope: $event })"
      @fields="fields = $event"
      @metrics="metrics = $event"
    />
  </section>
  <section class="management-section">
    <h3>偏好内容</h3>
    <label v-if="modelValue.value.type === 'metric'"
      >常用指标<ElSelect
        :model-value="modelValue.value.metric_id"
        filterable
        aria-label="常用指标"
        @update:model-value="value({ type: 'metric', metric_id: String($event) })"
        ><ElOption
          v-for="m in metrics"
          :key="m.metric_id + m.version"
          :value="m.metric_id"
          :label="m.name" /></ElSelect
    ></label>
    <TimeRangeEditor
      v-if="modelValue.value.type === 'time_range'"
      :model-value="modelValue.value.range"
      @update:model-value="value({ type: 'time_range', range: $event })"
    />
    <label v-if="modelValue.value.type === 'grouping'"
      >分组字段<ElSelect
        :model-value="modelValue.value.fields"
        multiple
        aria-label="分组字段"
        @update:model-value="value({ type: 'grouping', fields: $event })"
        ><ElOption
          v-for="field in fields"
          :key="field.name"
          :value="field.name"
          :label="field.label" /></ElSelect
    ></label>
    <template v-if="modelValue.value.type === 'presentation'">
      <label
        >展示格式<ElSelect
          :model-value="modelValue.value.format"
          aria-label="展示格式"
          @update:model-value="
            value({
              type: 'presentation',
              format: $event,
              ...($event === 'chart' ? { chart_type: 'bar' } : {}),
            })
          "
          ><ElOption value="table" label="表格" /><ElOption value="chart" label="图表" /><ElOption
            value="text"
            label="文字" /></ElSelect
      ></label>
      <label v-if="modelValue.value.format === 'chart'"
        >图表类型<ElSelect
          :model-value="modelValue.value.chart_type ?? 'bar'"
          aria-label="图表类型"
          @update:model-value="value({ ...modelValue.value, chart_type: $event })"
          ><ElOption value="bar" label="柱形图" /><ElOption value="line" label="折线图" /><ElOption
            value="pie"
            label="饼图" /></ElSelect
      ></label>
    </template>
    <template v-if="modelValue.value.type === 'query_habit'">
      <label
        >常用指标（可选）<ElSelect
          :model-value="modelValue.value.metric_id ?? ''"
          clearable
          aria-label="习惯指标"
          @update:model-value="value({ ...modelValue.value, metric_id: $event || undefined })"
          ><ElOption
            v-for="m in metrics"
            :key="m.metric_id + m.version"
            :label="m.name"
            :value="m.metric_id" /></ElSelect
      ></label>
      <ElCheckbox
        :model-value="!!modelValue.value.time_range"
        @update:model-value="
          value({
            ...modelValue.value,
            time_range: $event
              ? { type: 'relative', period: 'this_year', extent: 'full_period' }
              : undefined,
          })
        "
        >保存时间范围</ElCheckbox
      >
      <TimeRangeEditor
        v-if="modelValue.value.time_range"
        :model-value="modelValue.value.time_range"
        @update:model-value="value({ ...modelValue.value, time_range: $event })"
      />
      <label
        >常用分组<ElSelect
          :model-value="modelValue.value.dimensions"
          multiple
          aria-label="习惯分组"
          @update:model-value="value({ ...modelValue.value, dimensions: $event })"
          ><ElOption
            v-for="field in fields"
            :key="field.name"
            :value="field.name"
            :label="field.label" /></ElSelect
      ></label>
    </template>
    <template v-if="['filters', 'query_habit'].includes(modelValue.value.type)">
      <div v-for="(condition, index) in conditions()" :key="index" class="management-section">
        <div class="management-form-grid">
          <label
            >字段<ElSelect
              :model-value="condition.field"
              :aria-label="'筛选字段' + (index + 1)"
              @update:model-value="fieldChange(index, String($event))"
              ><ElOption
                v-for="field in fields"
                :key="field.name"
                :value="field.name"
                :label="field.label" /></ElSelect
          ></label>
          <label
            >比较方式<ElSelect
              :model-value="condition.op"
              :aria-label="'筛选操作' + (index + 1)"
              @update:model-value="changeOp(index, condition, $event)"
              ><ElOption
                v-for="op in fields.find((f) => f.name === condition.field)?.operators ?? [
                  'eq',
                  'neq',
                  'in',
                  'not_in',
                  'between',
                  'is_null',
                  'not_null',
                ]"
                :key="op"
                :value="op"
                :label="operations[op] ?? op" /></ElSelect
          ></label>
        </div>
        <TypedValue
          v-if="!['is_null', 'not_null'].includes(condition.op)"
          :model-value="condition.value"
          :data-type="condition.data_type"
          :allow-array="['in', 'not_in', 'between'].includes(condition.op)"
          :label="'筛选值' + (index + 1)"
          @update:model-value="patch(index, { ...condition, value: $event })"
        />
        <ElButton text @click="patch(index)">删除条件 {{ index + 1 }}</ElButton>
      </div>
      <ElButton :disabled="!fields.length || conditions().length >= 50" @click="addCondition"
        >添加筛选条件</ElButton
      >
    </template>
  </section>
  <ElCheckbox
    :model-value="modelValue.auto_apply"
    @update:model-value="emit('update:modelValue', { ...modelValue, auto_apply: !!$event })"
    >后续会话自动应用</ElCheckbox
  >
</template>
