<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElInput, ElDatePicker, ElOption, ElSelect, ElPopover } from "element-plus";
import { MoreHorizontal } from "lucide-vue-next";
import type { ReportDefinition, ReportParameter } from "@ai-data/contracts";
import type { ParameterDraft } from "../models/parameter-types";
import { parameterDefaultLabel, parameterInputRaw, parameterShape } from "../models/parameters";
const props = defineProps<{
  definition: ReportDefinition;
  parameter: ReportParameter;
  modelValue: ParameterDraft;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: ParameterDraft] }>();
const settings = ref(false);
const shape = computed(() => parameterShape(props.definition, props.parameter));
const raw = computed(() => parameterInputRaw(props.parameter, props.modelValue));
const hasValue = computed(
  () =>
    props.modelValue.mode === "value" ||
    (props.modelValue.mode === "default" &&
      props.parameter.default_value !== undefined &&
      props.parameter.default_value !== null),
);
const defaultLabel = computed(() => parameterDefaultLabel(props.parameter));
const relativeDefault = computed(
  () => props.modelValue.mode === "default" && !!props.parameter.relative_time,
);
const placeholder = computed(() =>
  props.parameter.default_value === null && props.modelValue.mode === "default"
    ? "默认：空值"
    : props.parameter.required
      ? "请输入"
      : "可选",
);
function update(value: unknown) {
  emit("update:modelValue", {
    mode: "value",
    raw: Array.isArray(value) ? value.join("\n") : String(value ?? ""),
  });
}
function mode(value: ParameterDraft["mode"]) {
  emit("update:modelValue", { mode: value, raw: raw.value });
  settings.value = false;
}
function rangePart(index: number, value: unknown) {
  const values = raw.value.split("\n");
  update(index === 0 ? [String(value), values[1] ?? ""] : [values[0] ?? "", String(value)]);
}
</script>
<template>
  <div class="parameter-direct-control">
    <div class="parameter-input-row">
      <ElInput
        v-if="modelValue.mode === 'null'"
        model-value="空值"
        :aria-label="parameter.label"
        disabled
      />
      <ElSelect
        v-else-if="parameter.allowed_values && shape !== 'range'"
        :model-value="
          shape === 'multiple' ? (hasValue ? raw.split('\n') : []) : hasValue ? raw : undefined
        "
        :multiple="shape === 'multiple'"
        :aria-label="parameter.label"
        :disabled="disabled"
        placeholder="请选择"
        @update:model-value="update"
      >
        <ElOption
          v-for="value in parameter.allowed_values.filter((item) => item !== null)"
          :key="String(value)"
          :value="String(value)"
          :label="value === true ? '是' : value === false ? '否' : String(value) || '空字符串'"
        />
      </ElSelect>
      <ElSelect
        v-else-if="parameter.data_type === 'boolean' && shape === 'scalar'"
        :model-value="raw || undefined"
        :aria-label="parameter.label"
        :disabled="disabled"
        placeholder="请选择"
        @update:model-value="update"
      >
        <ElOption label="是" value="true" /><ElOption label="否" value="false" />
      </ElSelect>
      <ElDatePicker
        v-else-if="['date', 'datetime'].includes(parameter.data_type) && shape !== 'multiple'"
        :model-value="shape === 'range' ? (raw ? raw.split('\n') : undefined) : raw"
        :type="
          shape === 'range'
            ? parameter.data_type === 'date'
              ? 'daterange'
              : 'datetimerange'
            : parameter.data_type === 'date'
              ? 'date'
              : 'datetime'
        "
        :value-format="parameter.data_type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm:ss'"
        :aria-label="parameter.label"
        :disabled="disabled"
        :clearable="false"
        :placeholder="relativeDefault ? defaultLabel : '选择日期'"
        :start-placeholder="relativeDefault ? defaultLabel : '开始日期'"
        :end-placeholder="relativeDefault ? '运行时确定' : '结束日期'"
        range-separator="至"
        @update:model-value="update"
      />
      <div v-else-if="shape === 'range'" class="parameter-number-range">
        <ElInput
          :model-value="raw.split('\n')[0] ?? ''"
          :aria-label="`${parameter.label}开始值`"
          :disabled="disabled"
          placeholder="开始值"
          @update:model-value="rangePart(0, $event)"
        />
        <span>至</span>
        <ElInput
          :model-value="raw.split('\n')[1] ?? ''"
          :aria-label="`${parameter.label}结束值`"
          :disabled="disabled"
          placeholder="结束值"
          @update:model-value="rangePart(1, $event)"
        />
      </div>
      <ElInput
        v-else
        :model-value="raw"
        :aria-label="parameter.label"
        :disabled="disabled"
        :type="shape === 'multiple' ? 'textarea' : 'text'"
        :rows="2"
        :placeholder="shape === 'multiple' ? '每行一个值' : placeholder"
        @update:model-value="update"
      />
      <ElPopover
        v-model:visible="settings"
        trigger="click"
        placement="bottom-end"
        :width="260"
        :disabled="disabled"
      >
        <template #reference
          ><ElButton
            text
            :disabled="disabled"
            :aria-label="`${parameter.label}取值设置`"
            class="parameter-settings-trigger"
            ><MoreHorizontal :size="16" /></ElButton
        ></template>
        <div class="parameter-value-options">
          <strong>{{ parameter.label }}</strong>
          <p>默认：{{ defaultLabel }}</p>
          <ElButton text :disabled="disabled" @click="mode('default')">{{
            parameter.default_value !== undefined || parameter.relative_time
              ? "恢复默认"
              : "不传此条件"
          }}</ElButton>
          <ElButton text :disabled="disabled" @click="mode('value')">手动输入</ElButton>
          <ElButton
            v-if="!parameter.required && shape === 'scalar'"
            text
            :disabled="disabled"
            @click="mode('null')"
            >使用空值 NULL</ElButton
          >
          <small v-if="parameter.min !== undefined || parameter.max !== undefined"
            >有效范围：{{ parameter.min ?? "不限" }} 至 {{ parameter.max ?? "不限" }}</small
          >
          <small v-if="parameter.relative_time">默认日期在每次运行时计算。</small>
        </div>
      </ElPopover>
    </div>
  </div>
</template>
