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
} from "element-plus";
import type {
  DataSourceManagementConfig,
  ManagedSecretReference,
  DatabaseTarget,
} from "@ai-data/contracts";
const draft = defineModel<DataSourceManagementConfig>({ required: true });
defineProps<{
  existing: boolean;
  disabled: boolean;
  references: ManagedSecretReference[];
  targets: DatabaseTarget[];
}>();
</script>
<template>
  <ElForm label-position="top" :disabled="disabled" @submit.prevent
    ><div class="management-form-grid">
      <ElFormItem label="数据源标识" required
        ><ElInput
          v-model="draft.source_id"
          :disabled="existing"
          maxlength="128"
          placeholder="例如 clinical" /></ElFormItem
      ><ElFormItem label="数据库类型"
        ><ElSelect
          v-model="draft.connector_kind"
          @change="
            draft.target_database = undefined;
            draft.oracle_connect_type = undefined;
            draft.oracle_connect_target = undefined;
          "
          ><ElOption
            v-for="kind in ['sqlserver', 'mysql', 'postgresql', 'oracle']"
            :key="kind"
            :label="kind"
            :value="kind" /></ElSelect></ElFormItem
      ><ElFormItem label="凭据引用" required class="wide"
        ><ElSelect v-model="draft.secret_ref" filterable placeholder="选择已保存凭据"
          ><ElOption
            v-for="item in references"
            :key="item.secret_ref"
            :label="`${item.secret_ref}${item.exists ? '' : ' · 缺失'}`"
            :value="item.secret_ref"
            :disabled="!item.exists" /></ElSelect
      ></ElFormItem>
      <template v-if="draft.connector_kind === 'oracle'"
        ><ElFormItem label="Oracle 连接方式" required
          ><ElSelect v-model="draft.oracle_connect_type"
            ><ElOption label="Service Name" value="service_name" /><ElOption
              label="SID"
              value="sid" /></ElSelect></ElFormItem
        ><ElFormItem label="Oracle 连接目标" required
          ><ElSelect
            v-model="draft.oracle_connect_target"
            filterable
            allow-create
            default-first-option
            ><ElOption
              v-for="target in targets"
              :key="target.connect_target"
              :value="target.connect_target"
              :label="target.name" /></ElSelect></ElFormItem
      ></template>
      <ElFormItem v-else label="目标数据库" required class="wide"
        ><ElSelect
          v-model="draft.target_database"
          filterable
          allow-create
          default-first-option
          placeholder="发现目标库后选择，或输入完整库名"
          ><ElOption
            v-for="target in targets"
            :key="target.connect_target"
            :value="target.connect_target"
            :label="target.name" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="查询超时（毫秒）"
        ><ElInputNumber
          v-model="draft.timeout_ms"
          v-number-accessibility
          :min="100"
          :max="120000"
          :precision="0" /></ElFormItem
      ><ElFormItem label="最大连接数"
        ><ElInputNumber
          v-model="draft.connection_pool_limit"
          v-number-accessibility
          :min="1"
          :max="100"
          :precision="0" /></ElFormItem
      ><ElFormItem label="最大并发请求"
        ><ElInputNumber
          v-model="draft.concurrency_limit"
          v-number-accessibility
          :min="1"
          :max="1000"
          :precision="0" /></ElFormItem
      ><ElFormItem label="单次最大行数"
        ><ElInputNumber
          v-model="draft.row_limit"
          v-number-accessibility
          :min="1"
          :max="100000"
          :precision="0" /></ElFormItem
      ><ElFormItem label="运行状态"
        ><ElCheckbox v-model="draft.is_enabled">启用数据源</ElCheckbox></ElFormItem
      >
    </div>
    <p v-if="draft.cost_limit !== undefined" class="management-help">
      历史成本值 {{ draft.cost_limit }} 随配置保留，该字段不参与执行控制。
    </p></ElForm
  >
</template>
