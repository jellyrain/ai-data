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
  ElButton,
} from "element-plus";
import type {
  DataSourceManagementConfig,
  DatabaseConnection,
  DatabaseTarget,
} from "@ai-data/contracts";
const draft = defineModel<DataSourceManagementConfig>({ required: true });
const oracleCdb = defineModel<string>("oracleCdb", { required: true });
const oracleType = defineModel<"sid" | "service_name">("oracleType", { required: true });
const props = defineProps<{
  existing: boolean;
  disabled: boolean;
  references: DatabaseConnection[];
  targets: DatabaseTarget[];
  targetsLoading: boolean;
  targetsError: string;
}>();
const emit = defineEmits<{ "connection-change": []; "discover-targets": [open: boolean] }>();
const labels = {
  sqlserver: "SQL Server",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  oracle: "Oracle",
};
function selectConnection(value: string) {
  const connection = props.references.find((item) => item.secret_ref === value);
  if (!connection) return;
  draft.value.connector_kind = connection.connector_kind;
  emit("connection-change");
}
</script>
<template>
  <ElForm label-position="top" :disabled="disabled" @submit.prevent
    ><div class="management-form-grid">
      <ElFormItem label="数据源标识" required
        ><ElInput
          v-model="draft.source_id"
          :disabled="existing"
          maxlength="128"
          placeholder="例如 门诊数据"
        />
        <p class="management-help">支持中文、英文、数字和 _ . -，以中文、英文或下划线开头。</p>
        <p class="management-help">创建后不可修改，需改名请重新创建。</p></ElFormItem
      ><ElFormItem label="数据库连接" required class="wide"
        ><ElSelect
          v-model="draft.secret_ref"
          aria-label="数据库连接"
          filterable
          placeholder="选择已创建的数据库连接"
          @change="selectConnection"
          ><ElOption
            v-for="item in references"
            :key="item.secret_ref"
            :label="`${item.secret_ref} · ${labels[item.connector_kind]}`"
            :value="item.secret_ref"
        /></ElSelect>
        <p v-if="draft.secret_ref" class="management-help">
          {{
            references.some((item) => item.secret_ref === draft.secret_ref)
              ? `数据库类型：${labels[draft.connector_kind]}`
              : "此连接不可用，请重新选择数据库连接。"
          }}
        </p></ElFormItem
      >
      <template v-if="draft.connector_kind === 'oracle'"
        ><ElFormItem label="发现入口类型" required>
          <ElSelect v-model="oracleType" aria-label="Oracle CDB 连接类型">
            <ElOption value="sid" label="SID" /><ElOption
              value="service_name"
              label="Service Name"
            />
          </ElSelect>
        </ElFormItem>
        <ElFormItem label="发现入口" required>
          <ElInput
            v-model="oracleCdb"
            placeholder="填写 CDB 的 SID 或 Service Name"
            aria-label="Oracle CDB 连接目标"
          />
        </ElFormItem>
        <ElFormItem label="Oracle 连接方式" required
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
            :loading="targetsLoading"
            loading-text="正在查询数据库…"
            @visible-change="emit('discover-targets', $event)"
            ><template #empty
              ><div class="target-discovery-empty">
                <span>{{
                  targetsLoading
                    ? "正在查询数据库…"
                    : targetsError || "未发现目标，可输入完整服务名"
                }}</span>
                <ElButton
                  v-if="targetsError && !targetsLoading"
                  link
                  type="primary"
                  @click="emit('discover-targets', true)"
                  >重试</ElButton
                >
              </div></template
            ><ElOption
              v-for="target in targets"
              :key="target.connect_target"
              :value="target.connect_target"
              :label="target.name" /></ElSelect></ElFormItem
      ></template>
      <ElFormItem v-else label="目标数据库" required class="wide"
        ><ElSelect
          v-model="draft.target_database"
          aria-label="目标数据库"
          filterable
          allow-create
          default-first-option
          placeholder="点击查询并选择数据库，也可输入完整库名"
          :disabled="!draft.secret_ref"
          :loading="targetsLoading"
          loading-text="正在查询数据库…"
          @visible-change="emit('discover-targets', $event)"
          ><template #empty
            ><div class="target-discovery-empty">
              <span>{{
                targetsLoading ? "正在查询数据库…" : targetsError || "未发现目标，可输入完整库名"
              }}</span>
              <ElButton
                v-if="targetsError && !targetsLoading"
                link
                type="primary"
                @click="emit('discover-targets', true)"
                >重试</ElButton
              >
            </div></template
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
<style scoped>
.target-discovery-empty {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: var(--app-muted);
  font-size: 13px;
}
</style>
