<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElForm, ElSelect, ElOption } from "element-plus";
import {
  stableStringify,
  type ManagedSecretReference,
  type ManagedSqlServerTransport,
  type SqlServerTransport,
} from "@ai-data/contracts";
import { DataAccessApi } from "../api/data-access-api";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import SqlServerTransportForm from "./sqlserver-transport-form.vue";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{ serviceId: string; references: ManagedSecretReference[] }>();
const selected = ref(""),
  loaded = ref<ManagedSqlServerTransport>(),
  uncertain = ref(false);
const draft = ref<SqlServerTransport>({ encrypt: true, trust_server_certificate: false });
const baseline = ref("");
const dirty = computed(() => !!loaded.value && stableStringify(draft.value) !== baseline.value);
const { scope, discard } = useManagementPage(
  () => {
    selected.value = "";
    loaded.value = undefined;
    baseline.value = "";
    uncertain.value = false;
    draft.value = { encrypt: true, trust_server_certificate: false };
  },
  () => dirty.value || uncertain.value,
);
function accept(value: ManagedSqlServerTransport) {
  loaded.value = value;
  draft.value = { ...value.sqlserver_transport };
  baseline.value = stableStringify(draft.value);
  uncertain.value = false;
}
async function read(value = selected.value) {
  if (!value || !(await discard())) return;
  await scope.run(async (request) => {
    const current = await new DataAccessApi(request, props.serviceId).sqlServerTransport(value);
    selected.value = value;
    accept(current);
  });
}
async function save() {
  if (!loaded.value || uncertain.value) return;
  const original = loaded.value;
  if (
    original.sources.length &&
    !(await confirmManagement(
      `保存后刷新以下业务数据源的连接：${original.sources.map((item) => item.source_id).join("、")}。`,
      "保存连接参数",
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    try {
      accept(
        await api.saveSqlServerTransport(original.secret_ref, {
          expected_revision: original.revision,
          sqlserver_transport: draft.value,
        }),
      );
      scope.state.notice = "连接参数已保存并回读，后续业务连接使用新设置。";
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        (error.status !== 409 && error.status !== 0 && error.status < 500) ||
        error.code === "CANCELLED"
      )
        throw error;
      uncertain.value = true;
      scope.state.notice = "保存结果需核对，编辑内容已保留。请读取最新参数后再修改。";
      if (error.status !== 409) {
        const current = await api.sqlServerTransport(original.secret_ref);
        if (
          current.origin === "credential" &&
          stableStringify(current.sqlserver_transport) === stableStringify(draft.value)
        ) {
          accept(current);
          scope.state.notice = "已回读确认连接参数已保存。";
        }
      }
    }
  });
}
defineExpose({ canLeave: discard });
</script>
<template>
  <section class="management-section" aria-label="已有凭据连接参数">
    <h3>业务 SQL Server 连接参数</h3>
    <p class="management-help">
      选择已有 SQL Server 凭据，仅修改连接选项。关联数据源共用这些设置。
    </p>
    <div class="management-actions">
      <ElSelect
        :model-value="selected"
        aria-label="连接参数凭据"
        filterable
        :disabled="scope.state.busy"
        @update:model-value="read"
      >
        <ElOption
          v-for="item in references.filter((row) => row.exists)"
          :key="item.secret_ref"
          :label="item.secret_ref"
          :value="item.secret_ref"
        />
      </ElSelect>
      <ElButton :disabled="!selected || scope.state.busy" @click="read()">读取最新参数</ElButton>
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <template v-if="loaded">
      <p class="management-help">
        {{
          loaded.origin === "credential"
            ? "已在 Web 设置，数据库发现和关联源使用以下参数。"
            : "尚未在 Web 设置，以下为数据库发现默认值。关联源当前设置列在下方。"
        }}
      </p>
      <ElForm label-position="top" :disabled="scope.state.busy || uncertain" @submit.prevent
        ><SqlServerTransportForm v-model="draft"
      /></ElForm>
      <ul v-if="loaded.origin === 'default' && loaded.sources.length" class="management-help">
        <li v-for="source in loaded.sources" :key="source.source_id">
          {{ source.source_id }} · {{ source.origin === "deployment" ? "部署配置" : "默认配置" }} ·
          加密{{ source.sqlserver_transport.encrypt ? "开启" : "关闭" }} · 证书信任{{
            source.sqlserver_transport.trust_server_certificate ? "开启" : "关闭"
          }}
        </li>
      </ul>
      <ElButton
        type="primary"
        :loading="scope.state.busy"
        :disabled="uncertain || (!dirty && loaded.origin === 'credential')"
        @click="save"
        >保存连接参数</ElButton
      >
    </template>
  </section>
</template>
