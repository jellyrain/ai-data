<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInput, ElSelect, ElOption } from "element-plus";
import {
  stableStringify,
  dataSourceManagementConfigSchema,
  type ManagedDataSource,
  type ManagedDataSourceDetail,
  type ManagedSecretReference,
  type DataSourceManagementConfig,
  type DatabaseTarget,
} from "@ai-data/contracts";
import { DataAccessApi } from "../api/data-access-api";
import SourceForm from "./source-form.vue";
import DatabaseCredentials from "./database-credentials.vue";
import ObjectWhitelist from "./object-whitelist.vue";
import ResourceList from "../../../shared/management/resource-list.vue";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{ serviceId: string }>();
const empty = (): DataSourceManagementConfig => ({
  source_id: "",
  connector_kind: "sqlserver",
  secret_ref: "",
  target_database: "",
  is_enabled: true,
  timeout_ms: 30000,
  connection_pool_limit: 5,
  concurrency_limit: 5,
  row_limit: 10000,
});
const items = ref<ManagedDataSource[]>([]),
  references = ref<ManagedSecretReference[]>([]),
  selected = ref<ManagedDataSourceDetail | null>(null),
  draft = ref(empty()),
  editing = ref(false),
  baseline = ref(""),
  targets = ref<DatabaseTarget[]>([]),
  remote = ref<ManagedDataSourceDetail | null>(null),
  showCredentials = ref(false),
  oracleCdb = ref(""),
  oracleType = ref<"sid" | "service_name">("service_name");
const credentials = ref<InstanceType<typeof DatabaseCredentials>>(),
  whitelist = ref<InstanceType<typeof ObjectWhitelist>>();
const { scope, discard } = useManagementPage(
  () => {
    items.value = [];
    references.value = [];
    selected.value = null;
    draft.value = empty();
    editing.value = false;
    baseline.value = "";
    targets.value = [];
    remote.value = null;
    showCredentials.value = false;
    oracleCdb.value = "";
  },
  () => editing.value && stableStringify(draft.value) !== baseline.value,
);
async function canLeave() {
  return (
    (await discard()) &&
    (await (credentials.value?.canLeave() ?? true)) &&
    (await (whitelist.value?.canLeave() ?? true))
  );
}
const rows = computed(() =>
  items.value.map((item) => ({
    id: item.source_id,
    title: item.source_id,
    status: item.is_enabled ? "启用" : "停用",
    description: `${item.connector_kind} · ${item.target_database ?? item.oracle_connect_target ?? "HTTP API"}`,
  })),
);
function list() {
  return scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    [items.value, references.value] = await Promise.all([api.sources(), api.secrets()]);
  });
}
function accept(value: ManagedDataSourceDetail) {
  selected.value = value;
  remote.value = null;
  targets.value = [];
  if (value.config && value.config.connector_kind !== "http_api") {
    draft.value = dataSourceManagementConfigSchema.parse({
      ...value.config,
      expected_revision: value.revision,
    });
    baseline.value = stableStringify(draft.value);
    editing.value = true;
  } else editing.value = false;
}
async function open(id: string) {
  if (!(await canLeave())) return;
  await scope.run(async (request) =>
    accept(await new DataAccessApi(request, props.serviceId).source(id)),
  );
}
async function create() {
  if (!(await canLeave())) return;
  selected.value = null;
  remote.value = null;
  draft.value = empty();
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  targets.value = [];
}
function discoverTargets() {
  return scope.run(async (request) => {
    targets.value = await new DataAccessApi(request, props.serviceId).targets({
      secret_ref: draft.value.secret_ref,
      connector_kind: draft.value.connector_kind,
      ...(draft.value.connector_kind === "oracle"
        ? { oracle_connect_type: oracleType.value, oracle_connect_target: oracleCdb.value }
        : {}),
    });
    scope.state.notice = `已发现 ${targets.value.length} 个目标，请在目标库字段中选择。`;
  });
}
async function save() {
  if (!editing.value || !(await (whitelist.value?.canLeave() ?? true))) return;
  if (
    selected.value?.config?.is_enabled &&
    !draft.value.is_enabled &&
    !(await confirmManagement("停用后此数据源的业务查询将不可用。", "停用数据源"))
  )
    return;
  await scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    let input = draft.value;
    if (!selected.value) {
      const value = await api.source(input.source_id);
      if (value.config) {
        remote.value = value;
        scope.state.notice = "此标识已有配置，已读取服务端内容。请核对后继续。";
        return;
      }
      input = { ...input, expected_revision: value.revision };
    }
    try {
      await api.saveSource(input);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        remote.value = await api.source(input.source_id);
        scope.state.notice = "保存结果待核对，已读取服务端配置，表单草稿保留。";
        return;
      }
      throw error;
    }
    accept(await api.source(input.source_id));
    items.value = await api.sources();
    scope.state.notice = "数据源配置已保存并回读，可继续发现对象。";
  });
}
async function rebase() {
  if (
    !remote.value ||
    !(await confirmManagement(
      "保留当前表单并采用服务端新指纹，下次保存将更新该数据源。",
      "核对数据源配置",
    ))
  )
    return;
  selected.value = remote.value;
  draft.value.expected_revision = remote.value.revision;
  remote.value = null;
}
async function toggleCredentials() {
  if (showCredentials.value && !(await (credentials.value?.canLeave() ?? true))) return;
  showCredentials.value = !showCredentials.value;
}
onMounted(list);
defineExpose({ canLeave });
</script>
<template>
  <section>
    <div class="management-actions">
      <ElButton :disabled="scope.state.busy" @click="list">刷新数据源</ElButton
      ><ElButton type="primary" :disabled="scope.state.busy" @click="create">新建数据源</ElButton
      ><ElButton :disabled="scope.state.busy" @click="toggleCredentials">{{
        showCredentials ? "收起凭据表单" : "保存数据库凭据"
      }}</ElButton>
    </div>
    <DatabaseCredentials
      v-if="showCredentials"
      ref="credentials"
      :service-id="serviceId"
      :references="references"
      @saved="list"
    /><ManagementFeedback v-bind="scope.state" />
    <div class="management-grid management-section">
      <ResourceList
        :items="rows"
        :selected="selected?.config?.source_id"
        :disabled="scope.state.busy"
        @select="open"
      />
      <main class="management-detail">
        <template v-if="editing"
          ><h2>{{ selected?.config ? "数据源配置" : "新建数据源" }}</h2>
          <SourceForm
            v-model="draft"
            :existing="!!selected?.config"
            :disabled="scope.state.busy"
            :references="references"
            :targets="targets"
          />
          <section class="management-section">
            <h3>发现目标数据库</h3>
            <div v-if="draft.connector_kind === 'oracle'" class="management-inline-row">
              <ElSelect v-model="oracleType" aria-label="Oracle CDB 连接类型"
                ><ElOption value="sid" label="SID" /><ElOption
                  value="service_name"
                  label="Service Name" /></ElSelect
              ><ElInput
                v-model="oracleCdb"
                placeholder="Oracle CDB 连接目标"
                aria-label="Oracle CDB 连接目标"
              />
            </div>
            <ElButton :loading="scope.state.busy" @click="discoverTargets"
              >使用凭据发现目标库</ElButton
            >
          </section>
          <div v-if="remote" role="alert">
            <h3>服务端当前配置</h3>
            <pre class="management-code">{{ JSON.stringify(remote.config, null, 2) }}</pre>
            <ElButton @click="rebase">已核对，保留草稿采用新基准</ElButton>
          </div>
          <footer class="management-footer">
            <ElButton type="primary" :loading="scope.state.busy" :disabled="!!remote" @click="save"
              >保存数据源</ElButton
            >
          </footer></template
        ><template v-else-if="selected?.config"
          ><h2>{{ selected.config.source_id }} · HTTP API</h2>
          <p class="muted">此类数据源在当前管理页提供配置查看。</p>
          <pre class="management-code">{{ JSON.stringify(selected.config, null, 2) }}</pre>
        </template>
        <div v-else class="management-empty">先保存数据库凭据，再创建数据源并选择目标库。</div>
        <ObjectWhitelist
          v-if="selected?.config"
          :key="`${serviceId}:${selected.config.source_id}:${selected.revision}`"
          ref="whitelist"
          :service-id="serviceId"
          :source-id="selected.config.source_id"
          :readonly="selected.config.connector_kind === 'http_api'"
        />
      </main>
    </div>
  </section>
</template>
