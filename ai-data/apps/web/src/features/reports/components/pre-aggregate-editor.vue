<script setup lang="ts">
import { ElButton, ElCheckbox, ElInput, ElSelect, ElOption } from "element-plus";
import type { EditorField, RelationalReportQuery } from "../models/definition-editor-types";
const props = defineProps<{
  modelValue?: RelationalReportQuery["from"]["pre_aggregate"];
  fields: EditorField[];
}>();
const emit = defineEmits<{
  "update:modelValue": [value: RelationalReportQuery["from"]["pre_aggregate"]];
}>();
const aggregations = {
  count: "计数",
  count_distinct: "去重计数",
  sum: "求和",
  avg: "平均",
  min: "最小",
  max: "最大",
};
function toggle(enabled: boolean) {
  const field = props.fields[0]?.name;
  if (!enabled) {
    emit("update:modelValue", undefined);
    return;
  }
  emit("update:modelValue", {
    group_by: field ? [field] : [],
    select: field ? [{ field, as: field.split(".").at(-1)! }] : [],
  });
}
function groups(fields: string[]) {
  const previous = props.modelValue;
  if (!previous) return;
  const select = previous.select.filter((s) => s.aggregation || fields.includes(s.field));
  for (const field of fields)
    if (!select.some((s) => !s.aggregation && s.field === field))
      select.push({ field, as: field.split(".").at(-1)! });
  emit("update:modelValue", { group_by: fields, select });
}
</script>
<template>
  <section class="pre-aggregate">
    <ElCheckbox :model-value="!!modelValue" @update:model-value="toggle(!!$event)"
      >关联前分组聚合</ElCheckbox
    >
    <template v-if="modelValue"
      ><p class="muted">先按这些字段汇总当前对象，再参与关联。</p>
      <label
        >分组字段<ElSelect
          :model-value="modelValue.group_by"
          multiple
          filterable
          aria-label="预聚合分组字段"
          @update:model-value="groups($event)"
          ><ElOption
            v-for="field in fields"
            :key="field.name"
            :value="field.name"
            :label="field.label" /></ElSelect
      ></label>
      <div v-for="(column, index) in modelValue.select" :key="index" class="editor-record">
        <div class="editor-grid">
          <label
            >原始字段<ElSelect
              :model-value="column.field"
              filterable
              @update:model-value="
                emit('update:modelValue', {
                  ...modelValue,
                  select: modelValue.select.map((c, i) =>
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
              @update:model-value="
                emit('update:modelValue', {
                  ...modelValue,
                  select: modelValue.select.map((c, i) =>
                    i === index ? { ...c, aggregation: $event || undefined } : c,
                  ),
                })
              "
              ><ElOption label="分组原值" value="" /><ElOption
                v-for="(name, fn) in aggregations"
                :key="fn"
                :label="name"
                :value="fn" /></ElSelect
          ></label>
        </div>
        <label
          >输出名称<ElInput
            :model-value="column.as"
            @update:model-value="
              emit('update:modelValue', {
                ...modelValue,
                select: modelValue.select.map((c, i) =>
                  i === index ? { ...c, as: String($event) } : c,
                ),
              })
            " /></label
        ><ElButton
          text
          @click="
            emit('update:modelValue', {
              ...modelValue,
              select: modelValue.select.filter((_, i) => i !== index),
            })
          "
          >移除输出</ElButton
        >
      </div>
      <ElButton
        :disabled="!fields.length"
        @click="
          emit('update:modelValue', {
            ...modelValue,
            select: [
              ...modelValue.select,
              {
                field: fields[0]!.name,
                aggregation: 'count',
                as: `count_${modelValue.select.length}`,
              },
            ],
          })
        "
        >添加预聚合输出</ElButton
      ></template
    >
  </section>
</template>
