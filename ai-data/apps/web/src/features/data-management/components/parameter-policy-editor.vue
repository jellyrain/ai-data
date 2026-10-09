<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElInput, ElSelect, ElOption } from "element-plus";
import type { Dataset, QueryParameterPolicy } from "@ai-data/contracts";
import { dataTypeLabels, operatorLabels } from "../stores/capability-editor";
import CapabilityValue from "./capability-value.vue";
const model = defineModel<QueryParameterPolicy[] | undefined>();
const props = defineProps<{ dataset: Dataset; disabled?: boolean }>();
const search = ref("");
const rows = computed(() =>
  props.dataset.query_parameters.filter((p) =>
    `${p.name} ${p.source_description ?? ""}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const missing = computed(
  () =>
    model.value?.filter((p) => !props.dataset.query_parameters.some((d) => d.name === p.name)) ??
    [],
);
const policy = (name: string) => model.value?.find((p) => p.name === name);
function patch(name: string, value: Partial<QueryParameterPolicy>) {
  model.value = policy(name)
    ? model.value?.map((p) => (p.name === name ? { ...p, ...value } : p))
    : [...(model.value ?? []), { name, ...value }];
}
function remove(name: string) {
  model.value = model.value?.filter((p) => p.name !== name);
}
function required(name: string, value: string) {
  patch(name, { required: value === "default" ? undefined : value === "required" });
}
const preview = (value: unknown) =>
  value === undefined
    ? "未设置"
    : value === null
      ? "空值"
      : typeof value === "boolean"
        ? value
          ? "是"
          : "否"
        : String(value);
</script>
<template>
  <section class="parameter-editor" aria-label="参数策略">
    <h3>参数策略</h3>
    <p class="management-help">输入参数来自数据源，可进一步限制操作、要求必填或设置默认值。</p>
    <p v-if="!dataset.query_parameters.length" class="management-help">
      当前对象没有输入参数，无需配置参数策略。
    </p>
    <ElInput
      v-if="dataset.query_parameters.length > 8"
      v-model="search"
      placeholder="搜索参数"
      aria-label="搜索参数"
      :disabled="disabled"
    />
    <div class="parameter-list" :class="{ 'is-scrollable': dataset.query_parameters.length > 8 }">
      <section v-for="p in rows" :key="p.name" class="parameter-row">
        <div class="parameter-heading">
          <div>
            <strong>{{ p.name }}</strong
            ><span class="muted"
              >{{ dataTypeLabels[p.data_type] }} ·
              {{ p.required ? "源要求必填" : "源允许选填" }}</span
            >
          </div>
          <ElButton
            text
            :disabled="disabled"
            :aria-label="`${policy(p.name) ? '恢复默认' : '配置参数'} ${p.name}`"
            @click="policy(p.name) ? remove(p.name) : patch(p.name, {})"
            >{{ policy(p.name) ? "恢复默认" : "自定义" }}</ElButton
          >
        </div>
        <p class="management-help">
          源允许：{{ p.allowed_ops.map((op) => operatorLabels[op]).join("、") }} · 源默认值：{{
            preview(p.default_value)
          }}
        </p>
        <div v-if="policy(p.name)" class="parameter-controls">
          <label
            >允许操作<ElSelect
              :model-value="policy(p.name)!.allowed_ops ?? p.allowed_ops"
              multiple
              :aria-label="`${p.name}参数操作`"
              :disabled="disabled"
              @update:model-value="patch(p.name, { allowed_ops: $event })"
              ><ElOption
                v-for="op in p.allowed_ops"
                :key="op"
                :value="op"
                :label="operatorLabels[op]" /></ElSelect
          ></label>
          <label
            >是否必填<ElSelect
              :model-value="
                policy(p.name)!.required === undefined
                  ? 'default'
                  : policy(p.name)!.required
                    ? 'required'
                    : 'optional'
              "
              :aria-label="`${p.name}必填策略`"
              :disabled="disabled"
              @update:model-value="required(p.name, $event)"
              ><ElOption label="继承数据源" value="default" /><ElOption
                label="必填"
                value="required" /><ElOption
                label="选填"
                value="optional"
                :disabled="p.required" /></ElSelect
          ></label>
          <label
            >默认值<CapabilityValue
              :model-value="policy(p.name)!.default_value"
              :data-type="p.data_type"
              :label="`${p.name}参数默认值`"
              default-label="继承数据源"
              :disabled="disabled"
              @update:model-value="patch(p.name, { default_value: $event })"
          /></label>
        </div>
      </section>
    </div>
    <div v-for="p in missing" :key="p.name" class="parameter-missing">
      <span>{{ p.name }}：参数已不可用，原配置已保留。</span
      ><ElButton text :disabled="disabled" @click="remove(p.name)">移除失效策略</ElButton>
    </div>
  </section>
</template>
<style scoped>
.parameter-editor {
  min-width: 0;
}
.parameter-editor h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.parameter-list.is-scrollable {
  max-height: 520px;
  overflow-y: auto;
}
.parameter-row {
  border-top: 1px solid var(--app-border);
  padding: 16px 0;
}
.parameter-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.parameter-heading strong {
  display: block;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.parameter-heading .muted {
  display: block;
  font-size: 12px;
  margin-top: 4px;
}
.parameter-controls {
  display: grid;
  gap: 12px;
}
.parameter-controls label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.parameter-missing {
  color: var(--el-color-danger);
  font-size: 13px;
}
</style>
