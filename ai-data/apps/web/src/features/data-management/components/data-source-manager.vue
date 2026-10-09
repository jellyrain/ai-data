<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElButton, ElInput, ElSelect, ElOption } from "element-plus";
import {
  stableStringify,
  dataSourceManagementConfigSchema,
  type deleteDataSourceSchema,
  type ManagedDataSource,
  type ManagedDataSourceDetail,
  type DatabaseConnection,
  type DataSourceManagementConfig,
  type DatabaseTarget,
} from "@ai-data/contracts";
import { DataAccessApi } from "../api/data-access-api";
import SourceForm from "./source-form.vue";
import ObjectWhitelist from "./object-whitelist.vue";
import ResourceCard from "../../../shared/management/resource-card.vue";
import { Database, ArrowLeft, Search } from "lucide-vue-next";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{ serviceId: string }>();
const emit = defineEmits<{ connections: [] }>();
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
  references = ref<DatabaseConnection[]>([]),
  selected = ref<ManagedDataSourceDetail | null>(null),
  draft = ref(empty()),
  editing = ref(false),
  baseline = ref(""),
  targets = ref<DatabaseTarget[]>([]),
  remote = ref<ManagedDataSourceDetail | null>(null),
  oracleCdb = ref(""),
  oracleType = ref<"sid" | "service_name">("service_name");
const whitelist = ref<InstanceType<typeof ObjectWhitelist>>();
const pendingDeletion = ref<ReturnType<typeof deleteDataSourceSchema.parse> | null>(null);
const discovering = ref(false),
  targetsError = ref("");
const discoveryKey = computed(() =>
  stableStringify([draft.value.secret_ref, oracleCdb.value, oracleType.value]),
);
watch(discoveryKey, () => {
  targets.value = [];
  targetsError.value = "";
});
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
    pendingDeletion.value = null;
    oracleCdb.value = "";
  },
  () => editing.value && stableStringify(draft.value) !== baseline.value,
);
async function canLeave() {
  return (await discard()) && (await (whitelist.value?.canLeave() ?? true));
}
const search = ref(""),
  kind = ref("all"),
  detailTab = ref("config");
const visible = computed(() =>
  items.value.filter(
    (item) =>
      (kind.value === "all" || item.connector_kind === kind.value) &&
      (item.source_id + " " + (item.target_database ?? item.oracle_connect_target ?? ""))
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const connectorLabel = (value: string) =>
  ({
    sqlserver: "SQL Server",
    postgresql: "PostgreSQL",
    mysql: "MySQL",
    oracle: "Oracle",
    http_api: "HTTP API",
  })[value] ?? value;
async function back() {
  if (pendingDeletion.value) return;
  if (!(await canLeave())) return;
  selected.value = null;
  draft.value = empty();
  editing.value = false;
  remote.value = null;
  targets.value = [];
}
async function selectTab(value: string) {
  if (pendingDeletion.value) return;
  if (value === detailTab.value || !(await canLeave())) return;
  if (selected.value) accept(selected.value);
  detailTab.value = value;
}
function list() {
  return scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    [items.value, references.value] = await Promise.all([api.sources(), api.connections()]);
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
  detailTab.value = "config";
  await scope.run(async (request) =>
    accept(await new DataAccessApi(request, props.serviceId).source(id)),
  );
}
async function create() {
  if (pendingDeletion.value) return;
  if (!(await canLeave())) return;
  detailTab.value = "config";
  selected.value = null;
  remote.value = null;
  draft.value = empty();
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  targets.value = [];
}
async function discoverTargets(open = true) {
  if (!open || scope.state.busy || !selectedConnection.value) return;
  if (draft.value.connector_kind === "oracle" && !oracleCdb.value.trim()) {
    targetsError.value = "请先填写 Oracle 发现入口";
    return;
  }
  const key = discoveryKey.value;
  discovering.value = true;
  targetsError.value = "";
  targets.value = [];
  try {
    await scope.run(async (request) => {
      try {
        const result = await new DataAccessApi(request, props.serviceId).testConnection(
          draft.value.secret_ref,
          draft.value.connector_kind === "oracle"
            ? { oracle_connect_type: oracleType.value, oracle_connect_target: oracleCdb.value }
            : {},
        );
        if (key === discoveryKey.value) targets.value = result;
      } catch (error) {
        if (key === discoveryKey.value) targetsError.value = "数据库查询失败，请重试";
        throw error;
      }
    });
  } finally {
    discovering.value = false;
  }
}
function connectionChanged() {
  targets.value = [];
  draft.value.target_database = undefined;
  draft.value.oracle_connect_type = undefined;
  draft.value.oracle_connect_target = undefined;
  oracleCdb.value = "";
}
const selectedConnection = computed(() =>
  references.value.find((item) => item.secret_ref === draft.value.secret_ref),
);
async function save() {
  if (!editing.value || !selectedConnection.value || !(await (whitelist.value?.canLeave() ?? true)))
    return;
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
async function remove() {
  const current = selected.value;
  if (!current?.config || (!pendingDeletion.value && !(await canLeave()))) return;
  await scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    const id = current.config!.source_id;
    const objects = pendingDeletion.value ? null : await api.objects(id);
    if (
      !pendingDeletion.value &&
      !(await confirmManagement(
        `删除数据源“${id}”及其 ${objects!.items.length} 个白名单对象，同时清理业务目录、关联关系和访问权限配置？后续查询将不可用。数据库连接、业务数据和历史记录会保留。`,
        "删除数据源",
      ))
    )
      return;
    const input = pendingDeletion.value ?? {
      source_id: id,
      expected_revision: current.revision,
      expected_objects_revision: objects!.revision,
    };
    try {
      await api.deleteSource(input);
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ))
        throw error;
      const actual = await api.source(id);
      if (actual.config) {
        pendingDeletion.value = null;
        remote.value = actual;
        scope.state.notice = "删除未完成，服务端配置已读取。请核对并重新打开数据源后再操作。";
        return;
      }
      pendingDeletion.value = input;
      scope.state.error = "数据源已移除，但 API 配置清理尚未确认完成，请重试删除清理。";
      return;
    }
    pendingDeletion.value = null;
    selected.value = null;
    editing.value = false;
    draft.value = empty();
    remote.value = null;
    targets.value = [];
    items.value = await api.sources();
    scope.state.notice = "数据源已删除。";
  });
}
function manageConnections() {
  emit("connections");
}
onMounted(list);
defineExpose({ canLeave });
</script>
<template>
  <section>
    <div class="management-subheading">
      <div class="management-title-group">
        <ElButton
          v-if="selected || editing"
          text
          aria-label="返回数据源列表"
          :disabled="scope.state.busy || !!pendingDeletion"
          @click="back"
          ><ArrowLeft :size="18"
        /></ElButton>
        <h2>数据源</h2>
      </div>
      <div class="management-actions">
        <ElButton :disabled="scope.state.busy" @click="list">刷新数据源</ElButton
        ><ElButton type="primary" :disabled="scope.state.busy || !!pendingDeletion" @click="create"
          >新建数据源</ElButton
        ><ElButton :disabled="scope.state.busy" @click="manageConnections">管理数据库连接</ElButton>
      </div>
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <template v-if="!selected && !editing">
      <div class="management-browse-toolbar">
        <ElInput v-model="search" clearable aria-label="搜索数据源" placeholder="搜索数据源或数据库"
          ><template #prefix><Search :size="16" /></template
        ></ElInput>
        <ElSelect v-model="kind" aria-label="数据源类型"
          ><ElOption label="全部类型" value="all" /><ElOption
            v-for="value in [...new Set(items.map((item) => item.connector_kind))]"
            :key="value"
            :label="connectorLabel(value)"
            :value="value"
        /></ElSelect>
        <span class="muted">当前 {{ visible.length }} 个数据源</span>
      </div>
      <div class="management-card-grid">
        <ResourceCard
          v-for="item in visible"
          :key="item.source_id"
          :title="item.source_id"
          :identifier="item.source_id"
          :status="item.is_enabled ? '启用' : '停用'"
          :active="item.is_enabled"
          :disabled="scope.state.busy"
          @select="open(item.source_id)"
        >
          <template #icon><Database :size="23" /></template>
          <span
            ><span>数据库类型</span><span>{{ connectorLabel(item.connector_kind) }}</span></span
          >
          <span
            ><span>目标数据库</span
            ><span>{{
              item.target_database ?? item.oracle_connect_target ?? "HTTP API"
            }}</span></span
          >
        </ResourceCard>
      </div>
      <p v-if="!visible.length" class="management-empty">
        {{
          scope.state.busy
            ? "正在读取数据源…"
            : items.length
              ? "没有匹配的数据源"
              : "选择已创建的数据库连接，新建数据源并绑定目标库。"
        }}
      </p>
    </template>
    <div v-else class="management-source-editor">
      <nav
        v-if="selected?.config && !pendingDeletion"
        class="management-tabs"
        aria-label="数据源详情"
      >
        <ElButton
          :type="detailTab === 'config' ? 'primary' : 'default'"
          @click="selectTab('config')"
          >连接配置</ElButton
        >
        <ElButton
          :type="detailTab === 'objects' ? 'primary' : 'default'"
          @click="selectTab('objects')"
          >对象白名单</ElButton
        >
      </nav>
      <main class="management-panel">
        <template v-if="pendingDeletion">
          <h2>{{ pendingDeletion.source_id }} · 删除待完成</h2>
          <p class="management-help">
            重试会核对数据源状态，并完成剩余的业务目录、关系和权限配置清理。
          </p>
          <ElButton type="primary" :loading="scope.state.busy" @click="remove"
            >重试删除清理</ElButton
          >
        </template>
        <template v-else-if="editing && detailTab === 'config'"
          ><h2>{{ selected?.config ? "数据源配置" : "新建数据源" }}</h2>
          <SourceForm
            v-model="draft"
            v-model:oracle-cdb="oracleCdb"
            v-model:oracle-type="oracleType"
            :existing="!!selected?.config"
            :disabled="scope.state.busy && !discovering"
            :references="references"
            :targets="targets"
            :targets-loading="discovering"
            :targets-error="targetsError"
            @connection-change="connectionChanged"
            @discover-targets="discoverTargets"
          />
          <p v-if="!references.length" class="management-help">
            还没有数据库连接，请先在“数据库连接”中新建。
          </p>
          <div v-if="remote" role="alert">
            <h3>服务端当前配置</h3>
            <pre class="management-code">{{ JSON.stringify(remote.config, null, 2) }}</pre>
            <ElButton @click="rebase">已核对，保留草稿采用新基准</ElButton>
          </div>
          <footer class="management-footer">
            <ElButton
              type="primary"
              :loading="scope.state.busy"
              :disabled="!!remote || !selectedConnection"
              @click="save"
              >保存数据源</ElButton
            >
            <ElButton
              v-if="selected?.config"
              type="danger"
              plain
              :disabled="scope.state.busy || !!remote"
              @click="remove"
              >删除数据源</ElButton
            >
          </footer></template
        ><template v-else-if="selected?.config && detailTab === 'config'"
          ><h2>{{ selected.config.source_id }} · HTTP API</h2>
          <p class="muted">此类数据源在当前管理页提供配置查看。</p>
          <pre class="management-code">{{ JSON.stringify(selected.config, null, 2) }}</pre>
          <ElButton type="danger" plain :disabled="scope.state.busy || !!remote" @click="remove"
            >删除数据源</ElButton
          >
        </template>

        <ObjectWhitelist
          v-if="selected?.config && detailTab === 'objects'"
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
