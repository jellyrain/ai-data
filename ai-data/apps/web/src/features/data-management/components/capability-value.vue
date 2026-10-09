<script setup lang="ts">
import { computed } from "vue";
import { ElInput, ElSelect, ElOption, ElDatePicker } from "element-plus";
import { isDataValue, type DatasetColumn } from "@ai-data/contracts";
const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    dataType: DatasetColumn["data_type"];
    label: string;
    disabled?: boolean;
    defaultLabel?: string;
  }>(),
  { defaultLabel: "未设置" },
);
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
const mode = computed(() =>
  props.modelValue === undefined ? "default" : props.modelValue === null ? "null" : "value",
);
function setMode(value: string) {
  emit(
    "update:modelValue",
    value === "default"
      ? undefined
      : value === "null"
        ? null
        : props.dataType === "boolean"
          ? false
          : ["integer", "decimal"].includes(props.dataType)
            ? 0
            : "",
  );
}
function input(value: string) {
  emit(
    "update:modelValue",
    ["integer", "decimal"].includes(props.dataType) &&
      value.trim() &&
      Number.isFinite(Number(value))
      ? Number(value)
      : value,
  );
}
</script>
<template>
  <div class="capability-value">
    <ElSelect
      :model-value="mode"
      :aria-label="`${label}方式`"
      :disabled="disabled"
      @update:model-value="setMode"
    >
      <ElOption :label="defaultLabel" value="default" /><ElOption
        label="指定值"
        value="value"
      /><ElOption label="空值" value="null" />
    </ElSelect>
    <template v-if="mode === 'value'">
      <ElSelect
        v-if="dataType === 'boolean'"
        :model-value="modelValue as boolean"
        :aria-label="label"
        :disabled="disabled"
        @update:model-value="emit('update:modelValue', $event)"
        ><ElOption label="是" :value="true" /><ElOption label="否" :value="false"
      /></ElSelect>
      <ElDatePicker
        v-else-if="dataType === 'date' || dataType === 'datetime'"
        :model-value="modelValue as string"
        :type="dataType === 'date' ? 'date' : 'datetime'"
        :value-format="dataType === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm:ss'"
        :aria-label="label"
        :disabled="disabled"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <ElInput
        v-else
        :model-value="String(modelValue ?? '')"
        :aria-label="label"
        :placeholder="
          dataType === 'buffer'
            ? 'Base64 文本'
            : ['integer', 'decimal'].includes(dataType)
              ? '输入数值'
              : '输入默认值'
        "
        :disabled="disabled"
        @update:model-value="input"
      />
      <span v-if="!isDataValue(modelValue, dataType)" class="value-error" role="alert"
        >默认值与字段类型不一致</span
      >
    </template>
  </div>
</template>
<style scoped>
.capability-value {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.capability-value > :deep(*) {
  min-width: 0;
}
.capability-value :deep(.el-select),
.capability-value :deep(.el-input) {
  width: auto;
  flex: 1 1 150px;
}
.value-error {
  color: var(--el-color-danger);
  font-size: 12px;
  flex-basis: 100%;
}
</style>
