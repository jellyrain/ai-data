<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput, ElSelect, ElOption, ElPopover } from "element-plus";
import { MoreHorizontal } from "lucide-vue-next";
import type { ReportParameter } from "@ai-data/contracts";
const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    dataType: ReportParameter["data_type"];
    label: string;
    optional?: boolean;
    simple?: boolean;
    allowArray?: boolean;
    allowNull?: boolean;
  }>(),
  { optional: true, allowArray: true, allowNull: true },
);
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
const raw = ref("");
const mode = computed(() =>
  props.modelValue === undefined
    ? "unset"
    : props.modelValue === null
      ? "null"
      : Array.isArray(props.modelValue)
        ? "array"
        : "value",
);
watch(
  () => [props.modelValue, props.dataType],
  () => {
    raw.value =
      props.modelValue === undefined || props.modelValue === null ? "" : String(props.modelValue);
  },
  { immediate: true },
);
function empty() {
  return props.dataType === "boolean"
    ? false
    : ["integer", "decimal"].includes(props.dataType)
      ? 0
      : "";
}
function changeMode(value: string) {
  emit(
    "update:modelValue",
    value === "unset"
      ? undefined
      : value === "null"
        ? null
        : value === "array"
          ? [empty()]
          : empty(),
  );
}
function commit() {
  emit(
    "update:modelValue",
    ["integer", "decimal"].includes(props.dataType) &&
      raw.value.trim() &&
      Number.isFinite(Number(raw.value))
      ? Number(raw.value)
      : raw.value,
  );
}
function changeItem(index: number, value: unknown) {
  const items = Array.isArray(props.modelValue) ? [...props.modelValue] : [];
  items[index] = value;
  emit("update:modelValue", items);
}
</script>
<template>
  <div class="typed-value" :class="{ 'simple-typed-value': simple }">
    <ElSelect
      v-if="!simple"
      :model-value="mode"
      :aria-label="`${label}取值方式`"
      @update:model-value="changeMode(String($event))"
    >
      <ElOption v-if="optional" label="未设置" value="unset" /><ElOption
        label="指定值"
        value="value"
      />
      <ElOption v-if="allowNull" label="空值 NULL" value="null" /><ElOption
        v-if="allowArray"
        label="多值 / 范围"
        value="array"
      />
    </ElSelect>
    <ElPopover v-if="simple" trigger="click" placement="bottom-end" :width="240"
      ><template #reference
        ><ElButton text :aria-label="`${label}设置`" class="typed-value-settings"
          ><MoreHorizontal :size="16" /></ElButton
      ></template>
      <p>默认取值</p>
      <ElSelect
        :model-value="mode"
        :aria-label="`${label}取值方式`"
        @update:model-value="changeMode(String($event))"
      >
        <ElOption v-if="optional" label="未设置" value="unset" /><ElOption
          label="指定值"
          value="value"
        />
        <ElOption v-if="allowNull" label="空值 NULL" value="null" /><ElOption
          v-if="allowArray"
          label="多值 / 范围"
          value="array"
        />
      </ElSelect>
    </ElPopover>
    <ElInput v-if="simple && mode === 'null'" model-value="空值" disabled :aria-label="label" />
    <template v-if="mode === 'value' || (simple && mode === 'unset')">
      <ElSelect
        v-if="dataType === 'boolean'"
        :model-value="modelValue as boolean"
        :aria-label="label"
        placeholder="未设置"
        @update:model-value="emit('update:modelValue', $event)"
        ><ElOption label="是" :value="true" /><ElOption label="否" :value="false"
      /></ElSelect>
      <ElInput
        v-else
        v-model="raw"
        :aria-label="label"
        :placeholder="
          dataType === 'date'
            ? 'YYYY-MM-DD'
            : dataType === 'datetime'
              ? 'YYYY-MM-DD HH:mm:ss'
              : dataType === 'buffer'
                ? 'Base64'
                : simple && mode === 'unset'
                  ? '未设置，可直接输入'
                  : '输入值'
        "
        @change="commit"
      />
    </template>
    <div v-if="Array.isArray(modelValue)" class="value-items">
      <div v-for="(item, index) in modelValue" :key="index" class="value-item">
        <TypedValue
          :model-value="item"
          :data-type="dataType"
          :label="`${label}第${index + 1}项`"
          :optional="false"
          :allow-array="false"
          @update:model-value="changeItem(index, $event)"
        /><ElButton
          text
          :aria-label="`移除${label}第${index + 1}项`"
          @click="
            emit(
              'update:modelValue',
              modelValue.filter((_, i) => i !== index),
            )
          "
          >移除</ElButton
        >
      </div>
      <ElButton
        :disabled="modelValue.length >= 1000"
        @click="emit('update:modelValue', [...modelValue, empty()])"
        >添加值</ElButton
      >
    </div>
  </div>
</template>
