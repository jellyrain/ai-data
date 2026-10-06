<script setup lang="ts">
import { ref, watch } from "vue";
import { ElButton, ElForm, ElFormItem } from "element-plus";
import type { ReportDefinitionVersion } from "@ai-data/contracts";
import { parameterDrafts, parameterShape, readParameters } from "../models/parameters";
import type { ParameterDrafts, ParameterValues } from "../models/parameter-types";
import ParameterInput from "./parameter-input.vue";
const props = defineProps<{
  definition: ReportDefinitionVersion;
  busy: boolean;
  uncertain: boolean;
  compact?: boolean;
  preview?: boolean;
  values?: ParameterValues;
}>();
const emit = defineEmits<{ run: [parameters: ParameterValues] }>();
const drafts = ref<ParameterDrafts>({});
const error = ref("");
watch(
  () => [props.definition, props.values] as const,
  ([value, values]) => {
    drafts.value = parameterDrafts(value.definition);
    for (const [name, raw] of Object.entries(values ?? {})) {
      if (drafts.value[name])
        drafts.value[name] = {
          mode: raw === null ? "null" : "value",
          raw: Array.isArray(raw) ? raw.join("\n") : String(raw),
        };
    }
    error.value = "";
  },
  { immediate: true },
);
function submit() {
  try {
    const values = readParameters(props.definition.definition, drafts.value);
    error.value = "";
    emit("run", values);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "请检查条件";
  }
}
</script>
<template>
  <ElForm
    class="report-parameters"
    :class="{ 'inline-parameters': compact, 'preview-parameters': preview }"
    :label-position="compact || preview ? 'left' : 'top'"
    :label-width="preview && !compact ? '104px' : undefined"
    :disabled="busy"
    @submit.prevent="!preview && submit()"
  >
    <p v-if="!definition.definition.parameters.length" class="muted">此报表使用固定查询条件。</p>
    <ElFormItem
      v-for="parameter in definition.definition.parameters"
      :key="parameter.name"
      :label="parameter.label"
      :required="parameter.required"
      :class="{
        'parameter-range-item': parameterShape(definition.definition, parameter) === 'range',
      }"
    >
      <ParameterInput
        v-model="drafts[parameter.name]!"
        :parameter="parameter"
        :definition="definition.definition"
        :disabled="busy"
      />
    </ElFormItem>
    <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
    <div class="parameter-form-actions">
      <ElButton
        native-type="submit"
        type="primary"
        :loading="busy"
        :disabled="preview"
        class="report-run"
        >{{ preview ? "查询" : uncertain ? "重试运行" : "运行报表" }}</ElButton
      >
      <ElButton
        :disabled="busy"
        @click="
          drafts = parameterDrafts(definition.definition);
          error = '';
        "
        >重置</ElButton
      >
    </div>
  </ElForm>
</template>
