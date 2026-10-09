<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import {
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElSelect,
  ElOption,
  ElButton,
  ElCheckbox,
} from "element-plus";
import type { ModelDraft } from "../stores/model-draft-types";
const draft = defineModel<ModelDraft>({ required: true });
defineProps<{ existing: boolean; disabled: boolean }>();
</script>
<template>
  <ElForm label-position="top" :disabled="disabled" @submit.prevent>
    <div class="management-form-grid">
      <ElFormItem label="模型标识" required
        ><ElInput
          v-model="draft.model_id"
          :disabled="existing"
          maxlength="128"
          placeholder="例如 rj-model"
      /></ElFormItem>
      <ElFormItem label="显示名称" required
        ><ElInput v-model="draft.name" maxlength="200"
      /></ElFormItem>
      <ElFormItem label="服务地址" class="wide" required
        ><ElInput
          v-model="draft.base_url"
          placeholder="例如 http://localhost:8000/v1"
          maxlength="2048"
        />
        <p class="management-help">兼容 Responses 的服务地址；认证在下方独立填写。</p></ElFormItem
      >
      <ElFormItem label="上游模型名称" required
        ><ElInput v-model="draft.model" maxlength="200"
      /></ElFormItem>
      <ElFormItem label="上下文窗口（tokens）"
        ><ElInputNumber
          v-model="draft.context_window"
          v-number-accessibility
          :min="4096"
          :max="2097152"
          :precision="0"
          :value-on-clear="undefined"
          placeholder="留空时探测模型能力"
        />
        <p class="management-help">留空时由运行时读取模型能力；Agent 可以覆盖此值。</p></ElFormItem
      >
    </div>
    <section class="management-section">
      <h3>本版本认证</h3>
      <p class="muted">每个版本独立保存完整认证。下列输入仅在本次编辑中保留。</p>
      <div class="management-form-grid management-auth-grid">
        <ElFormItem label="认证方式"
          ><ElSelect
            v-model="draft.authentication"
            @change="
              draft.authentication_confirmed = false;
              draft.api_key = '';
              draft.headers = [];
            "
            ><ElOption label="无需认证" value="none" /><ElOption
              label="API Key"
              value="key" /><ElOption label="自定义请求头" value="headers" /><ElOption
              label="API Key 与请求头"
              value="both" /></ElSelect
        ></ElFormItem>
        <ElFormItem v-if="['key', 'both'].includes(draft.authentication)" label="API Key" required
          ><ElInput
            v-model="draft.api_key"
            type="password"
            autocomplete="new-password"
            maxlength="8192"
        /></ElFormItem>
      </div>
      <div v-if="['headers', 'both'].includes(draft.authentication)">
        <div v-for="(row, index) in draft.headers" :key="index" class="management-inline-row">
          <ElInput
            v-model="row.name"
            :aria-label="`请求头 ${index + 1} 名称`"
            placeholder="请求头名称"
          /><ElInput
            v-model="row.value"
            :aria-label="`请求头 ${index + 1} 值`"
            type="password"
            autocomplete="new-password"
            placeholder="请求头值"
          /><ElButton @click="draft.headers.splice(index, 1)">移除</ElButton>
        </div>
        <ElButton
          :disabled="draft.headers.length >= 20"
          @click="draft.headers.push({ name: '', value: '' })"
          >添加请求头</ElButton
        >
      </div>
      <ElCheckbox v-model="draft.authentication_confirmed">已确认本版本的完整认证配置</ElCheckbox>
    </section>
  </ElForm>
</template>
