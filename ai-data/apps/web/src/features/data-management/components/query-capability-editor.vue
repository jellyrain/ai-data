<script setup lang="ts">
import { computed, ref } from "vue";
import { ElSelect, ElOption, ElCheckbox } from "element-plus";
import type {
  DatasetColumn,
  QueryCapabilities,
  QueryConditionCapability,
} from "@ai-data/contracts";
import {
  capabilityMode,
  changeCapabilityMode,
  capabilityNames,
  capabilityFields,
  selectCapabilityFields,
  aggregateFunctions,
  filterOperators,
  validateCapabilities,
  capabilityLabels,
  operatorLabels,
  aggregateLabels,
  dataTypeLabels,
  type CapabilityKey,
  type CapabilityMode,
  type AggregateFunction,
} from "../stores/capability-editor";
import CapabilityValue from "./capability-value.vue";
const model = defineModel<QueryCapabilities | undefined>();
const props = withDefaults(
  defineProps<{
    columns: DatasetColumn[];
    base?: QueryCapabilities;
    disabled?: boolean;
    ready?: boolean;
    inherit?: boolean;
    title?: string;
  }>(),
  { ready: true, title: "查询能力", base: undefined, disabled: false, inherit: false },
);
const custom = ref<Partial<Record<CapabilityKey, boolean>>>({});
const keys = Object.keys(capabilityLabels) as CapabilityKey[];
const mode = (key: CapabilityKey) =>
  custom.value[key] && model.value?.[key]?.length === 0
    ? "custom"
    : capabilityMode(model.value, key);
function setMode(key: CapabilityKey, value: CapabilityMode) {
  custom.value[key] = value === "custom";
  model.value = changeCapabilityMode(model.value, key, value);
}
function select(key: CapabilityKey, names: string[]) {
  model.value = selectCapabilityFields(model.value, key, names, props.columns, props.base);
}
function filter(index: number, patch: Partial<QueryConditionCapability>) {
  model.value = {
    ...model.value,
    filter_conditions: model.value?.filter_conditions?.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    ),
  };
}
function aggregation(index: number, functions: AggregateFunction[]) {
  model.value = {
    ...model.value,
    aggregations: model.value?.aggregations?.map((row, i) =>
      i === index ? { ...row, functions } : row,
    ),
  };
}
const column = (name: string) => props.columns.find((c) => c.name === name);
const missing = (key: CapabilityKey) =>
  capabilityNames(model.value, key).filter(
    (name) => !capabilityFields(props.columns, key, props.base).some((c) => c.name === name),
  );
const error = computed(() => {
  if (!props.ready) return "";
  try {
    validateCapabilities(model.value, props.columns, props.base);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : "请检查查询能力配置";
  }
});
</script>
<template>
  <section class="capability-editor" :aria-label="title">
    <h3>{{ title }}</h3>
    <p class="management-help">
      {{
        inherit
          ? "默认沿用数据源设置，自定义可缩小允许使用的范围。"
          : "默认使用对象的查询能力；需要限制时，选择字段和允许的操作。"
      }}
    </p>
    <p v-if="!ready" class="management-help">读取字段后即可选择查询能力，已有配置会保留。</p>
    <div v-for="key in keys" :key="key" class="capability-group">
      <div class="capability-heading">
        <div>
          <h4>{{ capabilityLabels[key] }}</h4>
          <span class="muted">{{
            mode(key) === "disabled"
              ? "已禁用"
              : mode(key) === "default"
                ? "使用默认设置"
                : `已选 ${capabilityNames(model, key).length} 个字段`
          }}</span>
        </div>
        <ElSelect
          :model-value="mode(key)"
          :aria-label="`${capabilityLabels[key]}配置方式`"
          :disabled="disabled || !ready"
          @update:model-value="setMode(key, $event)"
        >
          <ElOption label="默认" value="default" /><ElOption
            label="自定义"
            value="custom"
          /><ElOption label="禁用" value="disabled" />
        </ElSelect>
      </div>
      <template v-if="mode(key) === 'custom'">
        <ElSelect
          :model-value="capabilityNames(model, key)"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="3"
          :aria-label="`${capabilityLabels[key]}字段`"
          placeholder="搜索并选择字段"
          :disabled="disabled || !ready"
          @update:model-value="select(key, $event)"
        >
          <ElOption
            v-for="c in capabilityFields(columns, key, base)"
            :key="c.name"
            :value="c.name"
            :label="c.name"
            ><span>{{ c.name }}</span
            ><span class="field-type">{{ dataTypeLabels[c.data_type] }}</span></ElOption
          >
          <ElOption
            v-for="name in missing(key)"
            :key="name"
            :value="name"
            :label="`${name}（不可用）`"
          />
        </ElSelect>
        <p v-if="!capabilityFields(columns, key, base).length" class="management-help">
          当前数据源没有可用于{{ capabilityLabels[key] }}的字段。
        </p>
        <p v-else-if="!capabilityNames(model, key).length" class="management-help">
          选择字段后设置允许的操作；空集合保存后将禁用{{ capabilityLabels[key] }}。
        </p>
        <div v-if="key === 'filter_conditions'" class="capability-rows">
          <div
            v-for="(row, index) in model?.filter_conditions ?? []"
            :key="row.name"
            class="capability-row"
          >
            <div class="field-heading">
              <strong>{{ row.name }}</strong
              ><span class="muted">{{ dataTypeLabels[row.data_type] }}</span>
            </div>
            <label
              >允许操作<ElSelect
                :model-value="row.allowed_ops"
                multiple
                :aria-label="`${row.name}筛选操作`"
                :disabled="disabled || !ready"
                @update:model-value="filter(index, { allowed_ops: $event })"
                ><ElOption
                  v-for="op in column(row.name)
                    ? filterOperators(column(row.name)!, base)
                    : row.allowed_ops"
                  :key="op"
                  :value="op"
                  :label="operatorLabels[op]" />
                <ElOption
                  v-for="op in row.allowed_ops.filter(
                    (op) =>
                      column(row.name) && !filterOperators(column(row.name)!, base).includes(op),
                  )"
                  :key="`missing-${op}`"
                  :value="op"
                  :label="`${operatorLabels[op]}（不可用）`" /></ElSelect
            ></label>
            <details>
              <summary>必填与默认值</summary>
              <ElCheckbox
                :model-value="row.required"
                :disabled="
                  disabled ||
                  !ready ||
                  !!base?.filter_conditions?.find((c) => c.name === row.name)?.required
                "
                @update:model-value="filter(index, { required: !!$event })"
                >{{ row.name }}必填</ElCheckbox
              >
              <CapabilityValue
                :model-value="row.default_value"
                :data-type="row.data_type"
                :label="`${row.name}筛选默认值`"
                :disabled="disabled || !ready"
                @update:model-value="filter(index, { default_value: $event })"
              />
            </details>
          </div>
        </div>
        <div v-if="key === 'aggregations'" class="capability-rows">
          <label
            v-for="(row, index) in model?.aggregations ?? []"
            :key="row.field"
            class="capability-row"
            ><strong>{{ row.field }}</strong>
            <ElSelect
              :model-value="row.functions"
              multiple
              :aria-label="`${row.field}统计函数`"
              :disabled="disabled || !ready"
              @update:model-value="aggregation(index, $event)"
              ><ElOption
                v-for="fn in column(row.field)
                  ? aggregateFunctions(column(row.field)!, base)
                  : row.functions"
                :key="fn"
                :value="fn"
                :label="aggregateLabels[fn]" />
              <ElOption
                v-for="fn in row.functions.filter(
                  (fn) =>
                    column(row.field) && !aggregateFunctions(column(row.field)!, base).includes(fn),
                )"
                :key="`missing-${fn}`"
                :value="fn"
                :label="`${aggregateLabels[fn]}（不可用）`"
            /></ElSelect>
          </label>
        </div>
      </template>
    </div>
    <p v-if="error" class="capability-error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.capability-editor {
  min-width: 0;
}
.capability-editor h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.capability-group {
  border-top: 1px solid var(--app-border);
  padding: 16px 0;
}
.capability-heading,
.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.capability-heading {
  margin-bottom: 12px;
}
.capability-heading h4 {
  margin: 0 0 4px;
  font-size: 13px;
}
.capability-heading .muted,
.field-type {
  font-size: 12px;
}
.capability-heading > .el-select {
  width: 112px;
  flex: 0 0 112px;
}
.capability-group > .el-select,
.capability-row .el-select {
  width: 100%;
}
.field-type {
  float: right;
  margin-left: 20px;
  color: var(--app-muted);
}
.capability-rows {
  margin-top: 12px;
  max-height: 420px;
  overflow-y: auto;
  padding-right: 4px;
}
.capability-row {
  display: grid;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--app-border);
  font-size: 13px;
}
.capability-row strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.capability-row label {
  display: grid;
  gap: 6px;
}
.capability-row summary {
  color: var(--app-muted);
  cursor: pointer;
  margin-bottom: 8px;
}
.capability-row:last-child {
  border-bottom: 0;
}
.capability-error {
  color: var(--el-color-danger);
  white-space: pre-wrap;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
