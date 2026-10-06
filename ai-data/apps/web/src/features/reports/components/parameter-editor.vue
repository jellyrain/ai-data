<script setup lang="ts">
import { ref, watch } from "vue";
import { ElButton, ElInput, ElSelect, ElOption, ElCheckbox, ElMessageBox } from "element-plus";
import type { ReportDefinition, ReportParameter } from "@ai-data/contracts";
import {
  cloneDefinition,
  uniqueId,
  renameParameter,
  removeParameter,
} from "../models/definition-editor";
import {
  CalendarDays,
  Hash,
  ListFilter,
  ToggleLeft,
  Type,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-vue-next";
import { parameterDefaultLabel, parameterShape } from "../models/parameters";
import TypedValue from "./typed-value.vue";
import IdentifierInput from "./identifier-input.vue";
const props = defineProps<{ modelValue: ReportDefinition }>();
const emit = defineEmits<{ "update:modelValue": [value: ReportDefinition] }>();
const error = ref("");
const openParameter = ref("");
watch(
  () => props.modelValue.parameters.map((p) => p.name),
  (names) => {
    if (!names.includes(openParameter.value)) openParameter.value = names[0] ?? "";
  },
  { immediate: true },
);
function kind(parameter: ReportParameter) {
  const shape = parameterShape(props.modelValue, parameter);
  if (shape === "range")
    return ["date", "datetime"].includes(parameter.data_type) ? "日期范围" : "数值范围";
  if (shape === "multiple") return parameter.allowed_values ? "多选" : "多个值";
  return parameter.allowed_values
    ? "下拉选择"
    : parameter.data_type === "boolean"
      ? "是 / 否"
      : types[parameter.data_type];
}
function icon(parameter: ReportParameter) {
  if (["date", "datetime"].includes(parameter.data_type)) return CalendarDays;
  if (["integer", "decimal"].includes(parameter.data_type)) return Hash;
  if (parameter.data_type === "boolean") return ToggleLeft;
  return parameter.allowed_values ? ListFilter : Type;
}
const types = {
  string: "文本",
  integer: "整数",
  decimal: "小数",
  boolean: "布尔",
  date: "日期",
  datetime: "日期时间",
  buffer: "Base64",
};
function patch(index: number, change: Partial<ReportParameter>) {
  const value = cloneDefinition(props.modelValue);
  Object.assign(value.parameters[index]!, change);
  emit("update:modelValue", value);
}
function rename(previous: string, next: string) {
  try {
    const value = renameParameter(props.modelValue, previous, next);
    if (openParameter.value === previous) openParameter.value = next;
    emit("update:modelValue", value);
    error.value = "";
  } catch (e) {
    error.value = String((e as Error).message);
  }
}
function add() {
  const value = cloneDefinition(props.modelValue);
  value.parameters.push({
    name: uniqueId(
      "parameter",
      value.parameters.map((p) => p.name),
    ),
    label: "新条件",
    data_type: "string",
    required: false,
  });
  openParameter.value = value.parameters.at(-1)!.name;
  emit("update:modelValue", value);
}
async function remove(parameter: ReportParameter) {
  const count = props.modelValue.queries
    .flatMap((q) => q.bindings)
    .filter((b) => b.parameter === parameter.name).length;
  try {
    await ElMessageBox.confirm(
      `移除“${parameter.label}”及 ${count} 处查询绑定？涉及的固定块将解除引用并保留其余已展开内容。`,
      "删除条件",
      { confirmButtonText: "移除", cancelButtonText: "取消" },
    );
    emit("update:modelValue", removeParameter(props.modelValue, parameter.name));
  } catch {
    /* 用户取消删除。 */
  }
}
function relative(index: number, enabled: boolean) {
  patch(
    index,
    enabled
      ? {
          default_value: undefined,
          relative_time: {
            range: { type: "relative", period: "this_month", extent: "full_period" },
            part: "range",
          },
        }
      : { relative_time: undefined },
  );
}
</script>
<template>
  <section class="editor-section parameter-condition-editor">
    <header class="editor-section-heading">
      <div>
        <h2>筛选条件</h2>
        <p class="muted">选择一个条件，设置它的名称、关联字段与默认值。</p>
      </div>
      <ElButton :disabled="modelValue.parameters.length >= 100" @click="add"
        ><Plus :size="15" />添加条件</ElButton
      >
    </header>
    <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
    <p v-if="!modelValue.parameters.length" class="editor-empty">
      添加一个条件，选择它作用的字段。
    </p>
    <div class="condition-layout" :class="{ 'has-conditions': modelValue.parameters.length }">
      <div class="condition-workspace">
        <div class="condition-list" aria-label="筛选条件列表">
          <section
            v-for="parameter in modelValue.parameters"
            :key="parameter.name"
            class="condition-record"
            :class="{ 'is-open': openParameter === parameter.name }"
          >
            <button
              class="condition-summary"
              type="button"
              :aria-label="`编辑条件：${parameter.label}`"
              :aria-pressed="openParameter === parameter.name"
              @click="openParameter = parameter.name"
            >
              <component
                :is="icon(parameter)"
                :size="18"
                class="condition-icon"
                aria-hidden="true"
              />
              <strong>{{ parameter.label }}</strong
              ><span class="condition-kind">{{ kind(parameter) }}</span
              ><span
                class="condition-default-summary"
                :title="`默认：${parameterDefaultLabel(parameter)}`"
                >{{ parameterDefaultLabel(parameter) }}</span
              ><ChevronRight :size="14" aria-hidden="true" />
            </button>
          </section>
        </div>
        <slot name="preview" />
      </div>
      <template v-for="(parameter, index) in modelValue.parameters" :key="parameter.name">
        <section
          v-if="openParameter === parameter.name"
          class="parameter-inspector condition-body"
          aria-label="条件属性"
        >
          <header class="parameter-inspector-heading">
            <component :is="icon(parameter)" :size="19" aria-hidden="true" />
            <div>
              <h3>{{ parameter.label }}</h3>
              <p class="muted">{{ kind(parameter) }}</p>
            </div>
          </header>
          <div class="condition-basics">
            <label
              >显示名称<ElInput
                :model-value="parameter.label"
                :aria-label="`参数名称${index + 1}`"
                @update:model-value="patch(index, { label: String($event) })"
            /></label>
            <ElCheckbox
              class="condition-required"
              :model-value="parameter.required"
              @update:model-value="patch(index, { required: !!$event })"
              >必填</ElCheckbox
            >
          </div>
          <slot name="bindings" :parameter="parameter" />
          <div class="condition-default-settings">
            <label v-if="!parameter.relative_time"
              >默认值<TypedValue
                simple
                :model-value="parameter.default_value"
                :data-type="parameter.data_type"
                :label="`${parameter.label}默认值`"
                @update:model-value="
                  patch(index, {
                    default_value: $event as ReportParameter['default_value'],
                    relative_time: undefined,
                  })
                "
            /></label>
            <template v-if="['date', 'datetime'].includes(parameter.data_type)"
              ><ElCheckbox
                :model-value="!!parameter.relative_time"
                @update:model-value="relative(index, !!$event)"
                >按日期范围生成默认值</ElCheckbox
              >
              <div v-if="parameter.relative_time" class="editor-grid">
                <label
                  >时间范围<ElSelect
                    :model-value="
                      parameter.relative_time.range.type === 'relative'
                        ? parameter.relative_time.range.period
                        : 'fixed'
                    "
                    aria-label="默认时间范围"
                    @update:model-value="
                      patch(index, {
                        relative_time: {
                          ...parameter.relative_time!,
                          range:
                            $event === 'fixed'
                              ? { type: 'fixed', start: '', end: '' }
                              : { type: 'relative', period: $event, extent: 'full_period' },
                        },
                      })
                    "
                    ><ElOption label="本年" value="this_year" /><ElOption
                      label="本季度"
                      value="this_quarter" /><ElOption label="本月" value="this_month" /><ElOption
                      label="上年"
                      value="last_year" /><ElOption label="上月" value="last_month" /><ElOption
                      label="固定日期范围"
                      value="fixed" /></ElSelect
                ></label>
                <label
                  >取值<ElSelect
                    :model-value="parameter.relative_time.part"
                    aria-label="默认范围取值"
                    @update:model-value="
                      patch(index, { relative_time: { ...parameter.relative_time!, part: $event } })
                    "
                    ><ElOption label="开始日期" value="start" /><ElOption
                      label="结束日期"
                      value="end" /><ElOption label="整个范围" value="range" /></ElSelect
                ></label>
                <ElCheckbox
                  v-if="parameter.relative_time.range.type === 'relative'"
                  :model-value="parameter.relative_time.range.extent === 'to_date'"
                  @update:model-value="
                    patch(index, {
                      relative_time: {
                        ...parameter.relative_time!,
                        range: {
                          ...parameter.relative_time.range,
                          extent: $event ? 'to_date' : 'full_period',
                        },
                      },
                    })
                  "
                  >截止当天</ElCheckbox
                >
                <template v-else
                  ><label
                    >开始日期<ElInput
                      :model-value="parameter.relative_time.range.start"
                      placeholder="YYYY-MM-DD"
                      @update:model-value="
                        patch(index, {
                          relative_time: {
                            ...parameter.relative_time!,
                            range: {
                              ...(parameter.relative_time!.range as {
                                type: 'fixed';
                                start: string;
                                end: string;
                              }),
                              start: String($event),
                            },
                          },
                        })
                      " /></label
                  ><label
                    >结束日期<ElInput
                      :model-value="parameter.relative_time.range.end"
                      placeholder="YYYY-MM-DD"
                      @update:model-value="
                        patch(index, {
                          relative_time: {
                            ...parameter.relative_time!,
                            range: {
                              ...(parameter.relative_time!.range as {
                                type: 'fixed';
                                start: string;
                                end: string;
                              }),
                              end: String($event),
                            },
                          },
                        })
                      " /></label
                ></template></div
            ></template>
          </div>
          <details class="condition-advanced">
            <summary>高级设置</summary>
            <div class="editor-grid">
              <label
                >参数标识<IdentifierInput
                  :model-value="parameter.name"
                  :label="`参数标识${index + 1}`"
                  @change="rename(parameter.name, String($event))"
              /></label>
              <label
                >数据类型<ElSelect
                  :model-value="parameter.data_type"
                  :aria-label="`参数类型${index + 1}`"
                  @update:model-value="patch(index, { data_type: $event })"
                  ><ElOption
                    v-for="(label, type) in types"
                    :key="type"
                    :value="type"
                    :label="label" /></ElSelect
              ></label>
            </div>
            <label
              >允许值<TypedValue
                :model-value="parameter.allowed_values"
                :data-type="parameter.data_type"
                :label="`${parameter.label}允许值`"
                @update:model-value="
                  patch(index, {
                    allowed_values:
                      $event === undefined
                        ? undefined
                        : ((Array.isArray($event)
                            ? $event
                            : [$event]) as ReportParameter['allowed_values']),
                  })
                "
            /></label>
            <div class="editor-grid">
              <label
                >下限<TypedValue
                  :model-value="parameter.min"
                  :data-type="parameter.data_type"
                  :label="`${parameter.label}下限`"
                  :allow-array="false"
                  :allow-null="false"
                  @update:model-value="
                    patch(index, { min: $event as ReportParameter['min'] })
                  " /></label
              ><label
                >上限<TypedValue
                  :model-value="parameter.max"
                  :data-type="parameter.data_type"
                  :label="`${parameter.label}上限`"
                  :allow-array="false"
                  :allow-null="false"
                  @update:model-value="patch(index, { max: $event as ReportParameter['max'] })"
              /></label>
            </div>
          </details>
          <div class="condition-delete">
            <ElButton text type="danger" @click="remove(parameter)"
              ><Trash2 :size="14" />删除条件</ElButton
            >
          </div>
        </section>
      </template>
    </div>
  </section>
</template>
