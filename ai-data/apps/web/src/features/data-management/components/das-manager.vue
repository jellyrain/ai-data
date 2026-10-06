<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInput, ElSelect, ElOption } from "element-plus";
import type { ManagedDataAccessService } from "@ai-data/contracts";
import { useServices } from "../../../app/services";
import { DataAccessApi } from "../api/data-access-api";
import DataSourceManager from "./data-source-manager.vue";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import { useManagementPage } from "../../../shared/management/use-management-page";
const services = ref<ManagedDataAccessService[]>([]),
  selectedId = ref(""),
  credentialId = ref(""),
  credential = ref("");
const sourceManager = ref<InstanceType<typeof DataSourceManager>>();
const { auth } = useServices();
const isAdmin = computed(() => auth.state.context?.roles.includes("system_admin") ?? false);
const { scope, discard } = useManagementPage(
  () => {
    services.value = [];
    selectedId.value = "";
    credentialId.value = "";
    credential.value = "";
  },
  () => false,
);
const selected = computed(() =>
  services.value.find((item) => item.service_id === selectedId.value),
);
async function canLeave() {
  return (await discard()) && (await (sourceManager.value?.canLeave() ?? true));
}
async function list() {
  if (!(await canLeave())) return;
  return scope.run(async (request) => {
    services.value = await new DataAccessApi(request, "").services();
  });
}
async function select(value: string) {
  if (!(await canLeave())) return;
  selectedId.value = value;
  credential.value = "";
}
function issue() {
  return scope.run(async (request) => {
    credential.value = (
      await new DataAccessApi(request, credentialId.value).credential()
    ).credential;
  });
}
onMounted(list);
defineExpose({ canLeave });
</script>
<template>
  <section>
    <div class="management-toolbar">
      <ElSelect
        :model-value="selectedId"
        filterable
        placeholder="选择 DAS 实例"
        aria-label="DAS 实例"
        @update:model-value="select"
        ><ElOption
          v-for="item in services"
          :key="item.service_id"
          :value="item.service_id"
          :label="`${item.service_id} · ${item.connection_status === 'online' ? '在线' : item.connection_status === 'unhealthy' ? '异常' : '失联'}`" /></ElSelect
      ><ElButton :loading="scope.state.busy" @click="list">刷新实例</ElButton>
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <details v-if="isAdmin" class="management-section">
      <summary>领取实例注册凭据</summary>
      <p class="management-help">输入部署配置中已批准的实例 ID，领取该实例当前版本的接入凭据。</p>
      <div class="management-inline-row">
        <ElInput
          v-model="credentialId"
          placeholder="实例 ID"
          aria-label="领取凭据的实例 ID"
          autocomplete="off"
        /><ElButton :disabled="!credentialId || scope.state.busy" @click="issue">领取凭据</ElButton>
      </div>
      <ElInput
        v-if="credential"
        :model-value="credential"
        type="password"
        show-password
        readonly
        autocomplete="off"
        aria-label="实例注册凭据"
      /><ElButton v-if="credential" text @click="credential = ''">清除显示</ElButton>
    </details>
    <template v-if="selected"
      ><dl class="management-definition">
        <dt>实例地址</dt>
        <dd>{{ selected.service_url }}</dd>
        <dt>版本 / 状态</dt>
        <dd>
          {{ selected.service_version ?? "未知版本" }} ·
          {{
            selected.connection_status === "online"
              ? "在线"
              : selected.connection_status === "unhealthy"
                ? "异常"
                : "失联"
          }}
        </dd>
        <dt>最近心跳</dt>
        <dd>{{ selected.last_heartbeat_at }}</dd>
        <dt>数据源状态</dt>
        <dd>
          {{
            selected.sources.map((item) => `${item.source_id}: ${item.status}`).join("；") ||
            "尚未上报数据源"
          }}
        </dd>
      </dl>
      <DataSourceManager
        v-if="selected.connection_status === 'online'"
        :key="selected.service_id"
        ref="sourceManager"
        :service-id="selected.service_id"
      />
      <p v-else class="management-empty">
        实例当前不可用于管理调用，请恢复 DAS 注册和心跳后刷新。
      </p></template
    >
    <p v-else class="management-empty">
      选择实例查看状态与数据源。新实例成功注册后会出现在列表中。
    </p>
  </section>
</template>
