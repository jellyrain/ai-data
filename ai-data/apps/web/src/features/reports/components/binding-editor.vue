<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElSelect, ElOption } from "element-plus";
import { queryOperatorSchema } from "@ai-data/contracts";
import type {
  Dataset,
  ReportParameter,
  ReportParameterBinding,
  ReportQueryItem,
} from "@ai-data/contracts";
import { queryFields } from "../models/query-editing";
const props = defineProps<{
  modelValue: ReportParameterBinding[];
  parameters: ReportParameter[];
  query: ReportQueryItem["query"];
  datasets: Dataset[];
  parameterName?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: ReportParameterBinding[]] }>();
const visibleBindings = computed(() =>
  props.modelValue
    .map((binding, index) => ({ binding, index }))
    .filter((item) => !props.parameterName || item.binding.parameter === props.parameterName),
);
const objects = computed(() =>
  props.query.type === "relational_query" ? [props.query.from, ...props.query.joins] : [],
);
const dataset = computed(() =>
  props.query.type === "parameterized_query"
    ? props.datasets.find(
        (d) =>
          d.object_id ===
          (props.query as Extract<ReportQueryItem["query"], { type: "parameterized_query" }>).from
            .object_id,
      )
    : undefined,
);
const opLabels: Record<string, string> = {
  eq: "等于",
  neq: "不等于",
  in: "属于",
  not_in: "不属于",
  between: "范围",
};
function patch(index: number, value: ReportParameterBinding) {
  emit(
    "update:modelValue",
    props.modelValue.map((item, i) => (i === index ? value : item)),
  );
}
function add() {
  const parameter = props.parameterName
    ? props.parameters.find((item) => item.name === props.parameterName)
    : props.parameters[0];
  if (!parameter) return;
  const target: ReportParameterBinding["target"] =
    props.query.type === "metric_query"
      ? { type: "metric_date", part: "start" }
      : props.query.type === "parameterized_query"
        ? { type: "parameter", name: dataset.value?.query_parameters[0]?.name ?? "" }
        : {
            type: "filter",
            field: queryFields(props.query, props.datasets)[0]?.name ?? "",
            op: "eq",
            scope: "query",
          };
  emit("update:modelValue", [...props.modelValue, { parameter: parameter.name, target }]);
}
function fields(binding: ReportParameterBinding) {
  if (props.query.type !== "relational_query" || binding.target.type !== "filter") return [];
  const target = binding.target;
  if (["from", "join"].includes(target.scope))
    return queryFields(
      props.query,
      props.datasets,
      target.scope === "from" ? props.query.from.alias : target.alias,
      true,
    );
  const all = queryFields(props.query, props.datasets);
  if (target.scope !== "on") return all;
  const index = objects.value.findIndex((o) => o.alias === target.alias),
    aliases = objects.value.slice(0, index + 1).map((o) => o.alias);
  return all.filter((field) => aliases.includes(field.name.split(".")[0]!));
}
function scope(
  index: number,
  binding: ReportParameterBinding,
  value: "query" | "from" | "join" | "on",
) {
  if (binding.target.type !== "filter" || props.query.type !== "relational_query") return;
  const target: ReportParameterBinding["target"] = { ...binding.target, scope: value };
  if (value === "query") delete target.alias;
  else target.alias = value === "from" ? props.query.from.alias : props.query.joins[0]?.alias;
  patch(index, { ...binding, target });
}
</script>
<template>
  <section class="binding-editor" :class="{ 'condition-binding-editor': parameterName }">
    <header class="editor-record-heading">
      <h3>{{ parameterName ? "关联字段" : "参数绑定" }}</h3>
      <ElButton :disabled="!parameters.length || modelValue.length >= 100" @click="add">{{
        parameterName ? "添加关联" : "添加绑定"
      }}</ElButton>
    </header>
    <p v-if="!parameters.length" class="muted">先在“参数”中添加条件，再选择绑定位置。</p>
    <div v-for="{ binding, index } in visibleBindings" :key="index" class="editor-record">
      <label v-if="!parameterName"
        >使用参数<ElSelect
          :model-value="binding.parameter"
          :aria-label="`绑定参数${index + 1}`"
          @update:model-value="patch(index, { ...binding, parameter: String($event) })"
          ><ElOption
            v-for="parameter in parameters"
            :key="parameter.name"
            :value="parameter.name"
            :label="`${parameter.label} · ${parameter.name}`" /></ElSelect
      ></label>
      <template v-if="binding.target.type === 'filter'">
        <div class="editor-grid">
          <label
            >字段<ElSelect
              :model-value="binding.target.field"
              filterable
              :aria-label="`绑定字段${index + 1}`"
              @update:model-value="
                patch(index, { ...binding, target: { ...binding.target, field: String($event) } })
              "
              ><ElOption
                v-for="field in fields(binding)"
                :key="field.name"
                :value="field.name"
                :label="field.label" /></ElSelect></label
          ><label
            >比较<ElSelect
              :model-value="binding.target.op"
              :aria-label="`绑定操作${index + 1}`"
              @update:model-value="
                patch(index, { ...binding, target: { ...binding.target, op: $event } })
              "
              ><ElOption
                v-for="op in queryOperatorSchema.options.filter(
                  (o) => !['is_null', 'not_null'].includes(o),
                )"
                :key="op"
                :label="opLabels[op]"
                :value="op" /></ElSelect
          ></label>
        </div>
        <details class="binding-scope-settings">
          <summary>
            生效位置 ·
            {{
              { query: "查询结果", from: "主对象预过滤", join: "关联对象预过滤", on: "关联条件" }[
                binding.target.scope
              ]
            }}
          </summary>
          <div class="editor-grid">
            <label
              >生效位置<ElSelect
                :model-value="binding.target.scope"
                :aria-label="`绑定位置${index + 1}`"
                @update:model-value="scope(index, binding, $event)"
                ><ElOption label="查询结果筛选" value="query" /><ElOption
                  label="主对象预过滤"
                  value="from" /><ElOption label="关联对象预过滤" value="join" /><ElOption
                  label="关联 ON 条件"
                  value="on" /></ElSelect
            ></label>
            <label v-if="['join', 'on'].includes(binding.target.scope)"
              >关联对象<ElSelect
                :model-value="binding.target.alias"
                :aria-label="`绑定对象${index + 1}`"
                @update:model-value="
                  patch(index, { ...binding, target: { ...binding.target, alias: String($event) } })
                "
                ><ElOption
                  v-for="object in objects.slice(1)"
                  :key="object.alias"
                  :label="object.alias"
                  :value="object.alias" /></ElSelect
            ></label>
          </div>
        </details>
      </template>
      <label v-else-if="binding.target.type === 'parameter'"
        >命名输入<ElSelect
          :model-value="binding.target.name"
          :aria-label="`命名输入${index + 1}`"
          @update:model-value="
            patch(index, { ...binding, target: { type: 'parameter', name: String($event) } })
          "
          ><ElOption
            v-for="parameter in dataset?.query_parameters ?? []"
            :key="parameter.name"
            :label="parameter.name"
            :value="parameter.name" /></ElSelect
      ></label>
      <label v-else
        >指标日期<ElSelect
          :model-value="binding.target.part"
          :aria-label="`指标日期绑定${index + 1}`"
          @update:model-value="
            patch(index, { ...binding, target: { type: 'metric_date', part: $event } })
          "
          ><ElOption label="开始日期" value="start" /><ElOption
            label="结束日期"
            value="end" /></ElSelect
      ></label>
      <ElButton
        text
        type="danger"
        @click="
          emit(
            'update:modelValue',
            modelValue.filter((_, i) => i !== index),
          )
        "
        >移除绑定</ElButton
      >
    </div>
  </section>
</template>
