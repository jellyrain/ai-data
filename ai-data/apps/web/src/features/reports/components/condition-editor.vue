<script setup lang="ts">
import { ElButton, ElSelect, ElOption } from "element-plus";
import { queryOperatorSchema } from "@ai-data/contracts";
import type { FilterGroup, FilterCondition, EditorField } from "../models/definition-editor-types";
import TypedValue from "./typed-value.vue";
const props = withDefaults(
  defineProps<{
    modelValue?: FilterGroup;
    fields: EditorField[];
    label?: string;
    depth?: number;
  }>(),
  { modelValue: undefined, label: "筛选条件", depth: 0 },
);
const emit = defineEmits<{ "update:modelValue": [value: FilterGroup] }>();
const labels: Record<string, string> = {
  eq: "等于",
  neq: "不等于",
  in: "属于",
  not_in: "不属于",
  between: "范围",
  is_null: "为空",
  not_null: "不为空",
};
function patch(index: number, value: FilterCondition | FilterGroup) {
  const group = structuredClonePlain();
  group.items[index] = value;
  emit("update:modelValue", group);
}
function structuredClonePlain(): FilterGroup {
  return JSON.parse(JSON.stringify(props.modelValue ?? { logic: "and", items: [] })) as FilterGroup;
}
function add(nested = false) {
  const group = structuredClonePlain(),
    field = props.fields[0];
  if (!nested && !field) return;
  group.items.push(
    nested
      ? { logic: "and", items: [] }
      : {
          field: field!.name,
          data_type: field!.dataType,
          op: "eq",
          value:
            field!.dataType === "boolean"
              ? false
              : ["integer", "decimal"].includes(field!.dataType)
                ? 0
                : "",
        },
  );
  emit("update:modelValue", group);
}
function changeField(index: number, item: FilterCondition, name: string) {
  const field = props.fields.find((f) => f.name === name);
  if (!field) return;
  const op = field.operators?.[0] ?? item.op;
  patch(index, {
    field: name,
    op,
    data_type: field.dataType,
    ...(["is_null", "not_null"].includes(op) ? {} : { value: null }),
  });
}
function changeOp(index: number, item: FilterCondition, op: FilterCondition["op"]) {
  const next = { ...item, op };
  if (["is_null", "not_null"].includes(op)) delete next.value;
  else if (["in", "not_in", "between"].includes(op))
    next.value = Array.isArray(item.value)
      ? item.value
      : op === "between"
        ? [item.value ?? null, item.value ?? null]
        : [item.value ?? null];
  else next.value = Array.isArray(item.value) ? item.value[0] : (item.value ?? null);
  patch(index, next);
}
</script>
<template>
  <fieldset class="condition-group">
    <legend>{{ label }}</legend>
    <div class="editor-row">
      <ElSelect
        :model-value="modelValue?.logic ?? 'and'"
        :aria-label="`${label}组合方式`"
        @update:model-value="
          emit('update:modelValue', { logic: $event, items: modelValue?.items ?? [] })
        "
        ><ElOption label="满足全部（AND）" value="and" /><ElOption
          label="满足任一（OR）"
          value="or" /></ElSelect
      ><ElButton :disabled="!fields.length" @click="add()">添加条件</ElButton
      ><ElButton :disabled="depth >= 8" @click="add(true)">添加条件组</ElButton>
    </div>
    <div v-for="(item, index) in modelValue?.items ?? []" :key="index" class="condition-item">
      <ConditionEditor
        v-if="'logic' in item"
        :model-value="item"
        :fields="fields"
        :depth="depth + 1"
        :label="`${label}子组${index + 1}`"
        @update:model-value="patch(index, $event)"
      />
      <template v-else
        ><div class="editor-row">
          <ElSelect
            :model-value="item.field"
            filterable
            :aria-label="`${label}字段${index + 1}`"
            @update:model-value="changeField(index, item, String($event))"
            ><ElOption
              v-for="field in fields"
              :key="field.name"
              :value="field.name"
              :label="field.label" /></ElSelect
          ><ElSelect
            :model-value="item.op"
            :aria-label="`${label}操作${index + 1}`"
            @update:model-value="changeOp(index, item, $event)"
            ><ElOption
              v-for="op in fields.find((f) => f.name === item.field)?.operators ??
              queryOperatorSchema.options"
              :key="op"
              :value="op"
              :label="labels[op]"
          /></ElSelect>
        </div>
        <TypedValue
          v-if="!['is_null', 'not_null'].includes(item.op)"
          :model-value="item.value"
          :data-type="item.data_type"
          :label="`${label}值${index + 1}`"
          :optional="false"
          :allow-array="['in', 'not_in', 'between'].includes(item.op)"
          @update:model-value="patch(index, { ...item, value: $event })"
      /></template>
      <ElButton
        text
        type="danger"
        :aria-label="`移除${label}${index + 1}`"
        @click="
          emit('update:modelValue', {
            logic: modelValue!.logic,
            items: modelValue!.items.filter((_, i) => i !== index),
          })
        "
        >移除</ElButton
      >
    </div>
  </fieldset>
</template>
