<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import {
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElSelect,
  ElOption,
  ElCheckbox,
  ElCheckboxGroup,
  ElButton,
} from "element-plus";
import type {
  AgentDefinition,
  AgentToolEntry,
  SkillCatalogEntry,
  ModelConfiguration,
} from "@ai-data/contracts";
import { ref, watch } from "vue";
const section = ref("basic");
const draft = defineModel<AgentDefinition>({ required: true });
defineProps<{
  existing: boolean;
  disabled: boolean;
  models: ModelConfiguration[];
  tools: AgentToolEntry[];
  skills: SkillCatalogEntry[];
}>();
defineEmits<{ preview: [name: string] }>();
// Skill 子文档按需读取，选择资源时同时补齐其必需工具。
watch(
  () => draft.value.skill_names.length,
  (count) => {
    if (count > 0 && !draft.value.tool_names.includes("read_skill_reference"))
      draft.value.tool_names.push("read_skill_reference");
  },
);
</script>
<template>
  <ElForm label-position="top" :disabled="disabled" @submit.prevent>
    <nav class="management-tabs" aria-label="Agent 配置分区">
      <ElButton
        v-for="item in [
          { id: 'basic', label: '基本配置' },
          { id: 'tools', label: '工具' },
          { id: 'skills', label: 'Skill 资源' },
          { id: 'limits', label: '运行限制' },
        ]"
        :key="item.id"
        :type="section === item.id ? 'primary' : 'default'"
        @click="section = item.id"
        >{{ item.label }}</ElButton
      >
    </nav>
    <div v-show="section === 'basic'" class="management-form-grid">
      <ElFormItem label="Agent 标识" required
        ><ElInput v-model="draft.agent_id" :disabled="existing" maxlength="128" /></ElFormItem
      ><ElFormItem label="名称" required
        ><ElInput v-model="draft.name" maxlength="200"
      /></ElFormItem>
      <ElFormItem label="说明" class="wide"
        ><ElInput v-model="draft.description" type="textarea" :rows="2" maxlength="2000"
      /></ElFormItem>
      <ElFormItem label="模型" required
        ><ElSelect
          v-model="draft.model_id"
          aria-label="模型"
          filterable
          placeholder="选择模型"
          @change="
            draft.model_version = models.find((m) => m.model_id === draft.model_id)?.version ?? 1
          "
          ><ElOption
            v-for="model in models"
            :key="model.model_id"
            :label="`${model.name} · 最新 v${model.version}${model.enabled ? '' : ' · 已停用'}`"
            :value="model.model_id"
            :disabled="!model.enabled" /></ElSelect></ElFormItem
      ><ElFormItem label="固定模型版本" required
        ><ElInputNumber
          v-model="draft.model_version"
          v-number-accessibility
          :min="1"
          :max="models.find((m) => m.model_id === draft.model_id)?.version ?? 1"
          :precision="0"
        />
        <p class="management-help">发布后固定此版本；模型后续升级不会自动替换。</p></ElFormItem
      >
      <ElFormItem label="运行指令/系统提示词" class="wide"
        ><ElInput v-model="draft.instructions" type="textarea" :rows="6" maxlength="16000"
      /></ElFormItem>
    </div>
    <section v-show="section === 'tools'" class="management-section">
      <h3>工具</h3>
      <ElCheckboxGroup v-model="draft.tool_names" class="management-checks"
        ><ElCheckbox v-for="tool in tools" :key="tool.name" :value="tool.name"
          ><strong>{{ tool.name }}</strong
          ><small>{{ tool.description }}</small></ElCheckbox
        ></ElCheckboxGroup
      >
    </section>
    <section v-show="section === 'skills'" class="management-section">
      <h3>Skill 资源</h3>
      <p class="management-help">
        选择 Skill 时需启用 read_skill_reference 工具。发布时保存资源快照。
      </p>
      <ElCheckboxGroup v-model="draft.skill_names" class="management-checks"
        ><div v-for="skill in skills" :key="skill.name">
          <ElCheckbox :value="skill.name"
            ><strong>{{ skill.name }}</strong
            ><small>{{ skill.description }}</small></ElCheckbox
          ><ElButton text @click="$emit('preview', skill.name)">预览当前源文档</ElButton>
        </div></ElCheckboxGroup
      >
    </section>
    <section v-show="section === 'limits'" class="management-section">
      <h3>单轮运行限制</h3>
      <div class="management-form-grid">
        <ElFormItem label="超时（毫秒）"
          ><ElInputNumber
            v-model="draft.limits.timeout_ms"
            v-number-accessibility
            :min="1000"
            :max="600000"
            :step="1000"
            :precision="0" /></ElFormItem
        ><ElFormItem label="工具调用上限"
          ><ElInputNumber
            v-model="draft.limits.max_tool_calls"
            v-number-accessibility
            :min="1"
            :max="100"
            :precision="0" /></ElFormItem
        ><ElFormItem label="运行上下文预算（字节）"
          ><ElInputNumber
            v-model="draft.limits.max_context_bytes"
            v-number-accessibility
            :min="4096"
            :max="1048576"
            :precision="0" /></ElFormItem
        ><ElFormItem label="上下文窗口覆盖（tokens）"
          ><ElInputNumber
            v-model="draft.limits.context_window"
            v-number-accessibility
            :min="4096"
            :max="2097152"
            :precision="0"
            :value-on-clear="undefined"
          />
          <p class="management-help">
            留空沿用模型配置与能力探测；自动压缩阈值由运行时管理。
          </p></ElFormItem
        >
      </div>
    </section>
  </ElForm>
</template>
