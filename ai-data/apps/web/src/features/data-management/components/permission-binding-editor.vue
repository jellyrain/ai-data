<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElSelect, ElOption } from "element-plus";
import type { Dataset, QueryPermissionBinding, QueryParameterPolicy } from "@ai-data/contracts";
const model = defineModel<QueryPermissionBinding[] | undefined>();
const props = defineProps<{
  dataset: Dataset;
  policies?: QueryParameterPolicy[];
  disabled?: boolean;
}>();
const applicable = computed(() => ["stored_procedure", "api_dataset"].includes(props.dataset.kind));
function parameters(field: string, index = -1) {
  const column = props.dataset.columns.find((c) => c.name === field);
  return props.dataset.query_parameters.filter(
    (p) =>
      column?.data_type === p.data_type &&
      (
        props.policies?.find((policy) => policy.name === p.name)?.allowed_ops ?? p.allowed_ops
      ).includes("eq") &&
      !model.value?.some((b, i) => i !== index && b.parameter === p.name),
  );
}
const fields = (index = -1) =>
  props.dataset.columns.filter(
    (c) =>
      parameters(c.name, index).length &&
      !model.value?.some((b, i) => i !== index && b.field === c.name),
  );
function add() {
  const field = fields()[0];
  if (!field) return;
  model.value = [
    ...(model.value ?? []),
    { field: field.name, parameter: parameters(field.name)[0]!.name, operator: "eq" },
  ];
}
function patch(index: number, value: Partial<QueryPermissionBinding>) {
  model.value = model.value?.map((row, i) => (i === index ? { ...row, ...value } : row));
}
</script>
<template>
  <section class="binding-editor" aria-label="权限参数绑定">
    <h3>权限参数绑定</h3>
    <p class="management-help">
      将输出字段与同类型的输入参数对应。配置前需确认数据源会按该参数限制返回范围。
    </p>
    <p v-if="!applicable" class="management-help">
      表和视图通过行权限控制范围，无需配置权限参数绑定。
    </p>
    <p v-else-if="!dataset.query_parameters.length" class="management-help">
      当前对象没有输入参数，暂时无法建立绑定。
    </p>
    <div v-for="(row, index) in model ?? []" :key="index" class="binding-row">
      <label
        >输出字段<ElSelect
          :model-value="row.field"
          filterable
          :aria-label="`绑定输出字段 ${index + 1}`"
          :disabled="disabled || !applicable"
          @update:model-value="
            patch(index, { field: $event, parameter: parameters($event, index)[0]?.name ?? '' })
          "
          ><ElOption
            v-for="c in fields(index)"
            :key="c.name"
            :value="c.name"
            :label="c.name" /><ElOption
            v-if="!fields(index).some((c) => c.name === row.field)"
            :value="row.field"
            :label="`${row.field}（不可用）`"
            disabled /></ElSelect
      ></label>
      <span class="binding-equals">等于</span>
      <label
        >输入参数<ElSelect
          :model-value="row.parameter"
          filterable
          :aria-label="`绑定输入参数 ${index + 1}`"
          :disabled="disabled || !applicable"
          @update:model-value="patch(index, { parameter: $event })"
          ><ElOption
            v-for="p in parameters(row.field, index)"
            :key="p.name"
            :value="p.name"
            :label="p.name" /><ElOption
            v-if="!parameters(row.field, index).some((p) => p.name === row.parameter)"
            :value="row.parameter"
            :label="`${row.parameter || '请选择'}（不可用）`"
            disabled /></ElSelect
      ></label>
      <ElButton
        text
        :disabled="disabled"
        :aria-label="`移除权限绑定 ${index + 1}`"
        @click="model = model?.filter((_, i) => i !== index)"
        >移除</ElButton
      >
    </div>
    <ElButton
      v-if="applicable && dataset.query_parameters.length"
      :disabled="disabled || !fields().length || (model?.length ?? 0) >= 64"
      @click="add"
      >添加权限绑定</ElButton
    >
    <p
      v-if="applicable && dataset.query_parameters.length && !fields().length && !model?.length"
      class="management-help"
    >
      没有类型相同且支持等值操作的字段与参数。
    </p>
  </section>
</template>
<style scoped>
.binding-editor h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.binding-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 14px;
}
.binding-row label {
  display: grid;
  gap: 6px;
  min-width: 0;
  flex: 1;
  font-size: 13px;
}
.binding-equals {
  font-size: 12px;
  color: var(--app-muted);
  padding-bottom: 8px;
}
@media (max-width: 640px) {
  .binding-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .binding-row label {
    grid-column: 1;
  }
  .binding-equals {
    display: none;
  }
  .binding-row > .el-button {
    grid-column: 2;
    grid-row: 2;
  }
}
</style>
