<script setup lang="ts">
import { computed } from "vue";
import { ElSelect, ElOption, ElInput } from "element-plus";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import quarterOfYear from "dayjs/plugin/quarterOfYear";
import type { PreferenceTimeRange } from "@ai-data/contracts";
dayjs.extend(utc);
dayjs.extend(quarterOfYear);
const props = defineProps<{ modelValue: PreferenceTimeRange }>();
const emit = defineEmits<{ "update:modelValue": [PreferenceTimeRange] }>();
const periods = {
  this_year: "本年",
  this_quarter: "本季",
  this_month: "本月",
  last_year: "去年",
  last_month: "上月",
};
const preview = computed(() => {
  const value = props.modelValue;
  if (value.type === "fixed") return value.start + " 至 " + value.end;
  const now = dayjs().utcOffset(8),
    unit = value.period.includes("year")
      ? "year"
      : value.period.includes("quarter")
        ? "quarter"
        : "month";
  const target = value.period.startsWith("last") ? now.subtract(1, unit) : now;
  return (
    target.startOf(unit).format("YYYY-MM-DD") +
    " 至 " +
    (value.extent === "to_date" && target.isSame(now, unit) ? now : target.endOf(unit)).format(
      "YYYY-MM-DD",
    )
  );
});
function kind(value: string) {
  emit(
    "update:modelValue",
    value === "fixed"
      ? {
          type: "fixed",
          start: dayjs().utcOffset(8).format("YYYY-MM-DD"),
          end: dayjs().utcOffset(8).format("YYYY-MM-DD"),
        }
      : { type: "relative", period: "this_year", extent: "full_period" },
  );
}
</script>
<template>
  <div class="management-form-grid">
    <label
      >时间方式<ElSelect
        :model-value="modelValue.type"
        aria-label="时间方式"
        @update:model-value="kind(String($event))"
        ><ElOption value="relative" label="相对时间" /><ElOption
          value="fixed"
          label="固定日期" /></ElSelect
    ></label>
    <template v-if="modelValue.type === 'relative'">
      <label
        >周期<ElSelect
          :model-value="modelValue.period"
          aria-label="时间周期"
          @update:model-value="emit('update:modelValue', { ...modelValue, period: $event })"
          ><ElOption
            v-for="(label, value) in periods"
            :key="value"
            :value="value"
            :label="label" /></ElSelect
      ></label>
      <label
        >截止方式<ElSelect
          :model-value="modelValue.extent"
          aria-label="截止方式"
          @update:model-value="emit('update:modelValue', { ...modelValue, extent: $event })"
          ><ElOption value="full_period" label="完整周期" /><ElOption
            value="to_date"
            label="截至今天" /></ElSelect
      ></label>
    </template>
    <template v-else
      ><label
        >开始日期<ElInput
          type="date"
          :model-value="modelValue.start"
          aria-label="开始日期"
          @update:model-value="
            emit('update:modelValue', { ...modelValue, start: String($event) })
          " /></label
      ><label
        >结束日期<ElInput
          type="date"
          :model-value="modelValue.end"
          aria-label="结束日期"
          @update:model-value="
            emit('update:modelValue', { ...modelValue, end: String($event) })
          " /></label
    ></template>
  </div>
  <p class="management-help">当前范围（东八区）：{{ preview }}。相对时间在每次使用时重新计算。</p>
</template>
