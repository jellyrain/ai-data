<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  ElButton,
  ElInput,
  ElSelect,
  ElOption,
  ElForm,
  ElFormItem,
  ElInputNumber,
} from "element-plus";
import { ArrowLeft, Database, Search } from "lucide-vue-next";
import {
  stableStringify,
  testDatabaseConnectionDraftSchema,
  type DatabaseConnection,
  type DatabaseTarget,
} from "@ai-data/contracts";
import { DataAccessApi } from "../api/data-access-api";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import ResourceCard from "../../../shared/management/resource-card.vue";
import SqlServerTransportForm from "./sqlserver-transport-form.vue";
import { ApiError } from "../../../shared/http/api-error";
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";

const props = defineProps<{ serviceId: string }>();
const emit = defineEmits<{ sources: [] }>();
const empty = () => ({
  secret_ref: "",
  connector_kind: "sqlserver" as DatabaseConnection["connector_kind"],
  host: "",
  port: 1433,
  user: "",
  password: "",
  sqlserver_transport: { encrypt: true, trust_server_certificate: false },
});
const items = ref<DatabaseConnection[]>([]),
  selected = ref<DatabaseConnection | null>(null),
  draft = ref(empty()),
  editing = ref(false),
  baseline = ref(""),
  search = ref(""),
  remote = ref<DatabaseConnection | null>(null),
  uncertain = ref(false),
  targets = ref<DatabaseTarget[] | null>(null),
  oracleType = ref<"sid" | "service_name">("service_name"),
  oracleTarget = ref("");
const testing = ref(false);
const dirty = () => editing.value && stableStringify(draft.value) !== baseline.value;
const { scope, discard } = useManagementPage(() => {
  items.value = [];
  selected.value = null;
  draft.value = empty();
  editing.value = false;
  baseline.value = "";
  remote.value = null;
  uncertain.value = false;
  targets.value = null;
}, dirty);
const transportFields = computed(() =>
  draft.value.connector_kind === "sqlserver" &&
  (!selected.value ||
    selected.value.sqlserver_transport ||
    stableStringify(draft.value.sqlserver_transport) !==
      stableStringify(empty().sqlserver_transport))
    ? { sqlserver_transport: draft.value.sqlserver_transport }
    : {},
);
const testInput = computed(() => ({
  connector_kind: draft.value.connector_kind,
  host: draft.value.host,
  port: draft.value.port,
  user: draft.value.user,
  password: draft.value.password,
  ...transportFields.value,
  ...(selected.value
    ? {
        saved_connection: {
          secret_ref: selected.value.secret_ref,
          expected_revision: selected.value.revision,
        },
      }
    : {}),
  ...(draft.value.connector_kind === "oracle"
    ? { oracle_connect_type: oracleType.value, oracle_connect_target: oracleTarget.value }
    : {}),
}));
const canTest = computed(
  () => testDatabaseConnectionDraftSchema.safeParse(testInput.value).success,
);
watch(testInput, () => {
  targets.value = null;
  if (scope.state.notice.startsWith("连接测试成功")) scope.state.notice = "";
});
const labels = {
  sqlserver: "SQL Server",
  mysql: "MySQL",
  postgresql: "PostgreSQL",
  oracle: "Oracle",
};
const visible = computed(() =>
  items.value.filter((item) =>
    [item.secret_ref, item.host, labels[item.connector_kind]]
      .join(" ")
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
function list() {
  return scope.run(async (request) => {
    items.value = await new DataAccessApi(request, props.serviceId).connections();
  });
}
function accept(value: DatabaseConnection) {
  selected.value = value;
  draft.value = {
    ...empty(),
    ...value,
    password: "",
    sqlserver_transport: value.sqlserver_transport ?? empty().sqlserver_transport,
  };
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  remote.value = null;
  uncertain.value = false;
  targets.value = null;
  oracleTarget.value = "";
}
async function open(id: string) {
  if (!(await discard())) return;
  await scope.run(async (request) =>
    accept(await new DataAccessApi(request, props.serviceId).connection(id)),
  );
}
async function create() {
  if (!(await discard())) return;
  selected.value = null;
  draft.value = empty();
  baseline.value = stableStringify(draft.value);
  editing.value = true;
  remote.value = null;
  uncertain.value = false;
  targets.value = null;
}
async function back() {
  if (!(await discard())) return;
  editing.value = false;
  selected.value = null;
  draft.value = empty();
  remote.value = null;
  uncertain.value = false;
  targets.value = null;
  await list();
}
function changeType() {
  draft.value.port = { sqlserver: 1433, mysql: 3306, postgresql: 5432, oracle: 1521 }[
    draft.value.connector_kind
  ];
}
async function save() {
  if (
    selected.value?.source_ids.length &&
    !(await confirmManagement("保存后，使用此连接的数据源将切换到最新连接配置。", "更新数据库连接"))
  )
    return;
  await scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    const { host, port, user, password } = draft.value;
    const transport = transportFields.value;
    try {
      const value = selected.value
        ? await api.updateConnection(selected.value.secret_ref, {
            host,
            port,
            user,
            ...(password ? { password } : {}),
            ...transport,
            expected_revision: selected.value.revision,
          })
        : await api.createConnection({
            secret_ref: draft.value.secret_ref,
            connector_kind: draft.value.connector_kind,
            host,
            port,
            user,
            password,
            ...transport,
          });
      accept(value);
      items.value = await api.connections();
      scope.state.notice = "数据库连接已保存，可以创建数据源。";
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        uncertain.value = error.status !== 409;
        try {
          remote.value = await api.connection(selected.value?.secret_ref ?? draft.value.secret_ref);
        } catch (readError) {
          if (!(readError instanceof ApiError && readError.status === 404)) throw readError;
        }
        scope.state.notice =
          error.status === 409
            ? "连接名称已存在或内容已更新，草稿已保留。请读取当前连接核对。"
            : "保存结果待核对，草稿已保留。请读取当前连接；需要更换密码时可核对后重新填写。";
        return;
      }
      throw error;
    }
  });
}
async function reload() {
  if (!(await discard())) return;
  await scope.run(async (request) =>
    accept(
      await new DataAccessApi(request, props.serviceId).connection(
        selected.value?.secret_ref ?? draft.value.secret_ref,
      ),
    ),
  );
}
async function remove() {
  const value = selected.value;
  if (!value) return;
  if (value.source_ids.length) {
    scope.state.notice = "此连接正在使用，暂时无法删除。";
    return;
  }
  if (
    !(await discard()) ||
    !(await confirmManagement(`删除数据库连接“${value.secret_ref}”？`, "删除数据库连接"))
  )
    return;
  await scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    try {
      await api.deleteConnection(value.secret_ref, value.revision);
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ))
        throw error;
      try {
        const current = await api.connection(value.secret_ref);
        accept(current);
        scope.state.notice = current.source_ids.length
          ? "此连接正在使用，未删除。"
          : "删除结果待核对，已读取当前连接。";
        return;
      } catch (readError) {
        if (!(readError instanceof ApiError && readError.status === 404)) throw readError;
      }
    }
    editing.value = false;
    selected.value = null;
    draft.value = empty();
    items.value = await api.connections();
    scope.state.notice = "数据库连接已删除。";
  });
}
async function test() {
  testing.value = true;
  try {
    await scope.run(async (request) => {
      targets.value = null;
      targets.value = await new DataAccessApi(request, props.serviceId).testConnectionDraft(
        testInput.value,
      );
      scope.state.notice = `连接测试成功，发现 ${targets.value.length} 个数据库。`;
    });
  } finally {
    testing.value = false;
  }
}
async function toSources() {
  if (await discard()) emit("sources");
}
onMounted(list);
defineExpose({ canLeave: discard });
</script>
<template>
  <section>
    <div class="management-subheading">
      <div class="management-title-group">
        <ElButton
          v-if="editing"
          text
          aria-label="返回数据库连接列表"
          :disabled="scope.state.busy"
          @click="back"
          ><ArrowLeft :size="18"
        /></ElButton>
        <h2>数据库连接</h2>
      </div>
      <div class="management-actions">
        <ElButton
          v-if="!editing || selected || remote || uncertain"
          :disabled="scope.state.busy"
          @click="editing ? reload() : list()"
          >{{ editing ? "读取当前连接" : "刷新连接" }}</ElButton
        ><ElButton type="primary" :disabled="scope.state.busy" @click="create"
          >新建数据库连接</ElButton
        >
      </div>
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <template v-if="!editing">
      <div class="management-browse-toolbar">
        <ElInput
          v-model="search"
          clearable
          aria-label="搜索数据库连接"
          placeholder="搜索连接名称、类型或主机"
          ><template #prefix><Search :size="16" /></template></ElInput
        ><span class="muted">共 {{ items.length }} 个连接</span>
      </div>
      <div v-if="visible.length" class="management-card-grid">
        <ResourceCard
          v-for="item in visible"
          :key="item.secret_ref"
          :title="item.secret_ref"
          :identifier="`${item.host}:${item.port}`"
          :status="labels[item.connector_kind]"
          :disabled="scope.state.busy"
          class="connection-card"
          @select="open(item.secret_ref)"
        >
          <template #icon><Database :size="23" aria-hidden="true" /></template>
        </ResourceCard>
      </div>
      <div v-else class="management-empty">
        <p>
          {{
            scope.state.busy
              ? "正在读取数据库连接…"
              : items.length
                ? "没有匹配的连接"
                : "还没有数据库连接"
          }}
        </p>
        <p v-if="!items.length && !scope.state.busy">
          先创建数据库连接，再选择目标数据库创建数据源。
        </p>
      </div>
    </template>
    <section v-else class="management-panel management-source-editor" aria-label="数据库连接编辑">
      <h2>{{ selected ? selected.secret_ref : "新建数据库连接" }}</h2>
      <ElForm label-position="top" :disabled="scope.state.busy" @submit.prevent
        ><div class="management-form-grid">
          <ElFormItem label="连接名称" required
            ><ElInput
              v-model="draft.secret_ref"
              :disabled="!!selected"
              maxlength="128"
              placeholder="例如 医院业务库"
            />
            <p class="management-help">支持中文名称。创建后不可修改，需改名请重新创建。</p>
          </ElFormItem>
          <ElFormItem label="数据库类型" required
            ><ElSelect v-model="draft.connector_kind" :disabled="!!selected" @change="changeType"
              ><ElOption
                v-for="(label, value) in labels"
                :key="value"
                :label="label"
                :value="value" /></ElSelect
          ></ElFormItem>
          <ElFormItem label="主机" required
            ><ElInput v-model="draft.host" autocomplete="off"
          /></ElFormItem>
          <ElFormItem label="端口" required
            ><ElInputNumber
              v-model="draft.port"
              v-number-accessibility
              :min="1"
              :max="65535"
              :precision="0"
          /></ElFormItem>
          <ElFormItem label="数据库账号" required
            ><ElInput v-model="draft.user" autocomplete="off"
          /></ElFormItem>
          <ElFormItem label="密码" :required="!selected"
            ><ElInput
              v-model="draft.password"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="selected ? '留空保留原密码' : '填写数据库密码'"
          /></ElFormItem>
          <SqlServerTransportForm
            v-if="draft.connector_kind === 'sqlserver'"
            v-model="draft.sqlserver_transport"
            class="connection-transport"
          />
          <template v-if="draft.connector_kind === 'oracle'">
            <ElFormItem label="Oracle 测试连接方式" required>
              <ElSelect v-model="oracleType" aria-label="Oracle 测试连接方式">
                <ElOption label="Service Name" value="service_name" /><ElOption
                  label="SID"
                  value="sid"
                />
              </ElSelect>
            </ElFormItem>
            <ElFormItem label="Oracle 测试连接目标" required>
              <ElInput
                v-model="oracleTarget"
                aria-label="Oracle 测试连接目标"
                placeholder="填写 CDB 的 SID 或 Service Name"
              />
            </ElFormItem>
          </template></div
      ></ElForm>
      <p v-if="remote || uncertain" class="management-help">
        请通过“读取当前连接”核对服务器已保存的内容，密码可重新填写。
      </p>
      <div class="management-footer connection-actions">
        <ElButton
          :loading="testing"
          :disabled="scope.state.busy || !canTest || uncertain || !!remote"
          @click="test"
          >测试连接</ElButton
        >
        <ElButton
          type="primary"
          :loading="scope.state.busy && !testing"
          :disabled="scope.state.busy || !!remote || uncertain"
          @click="save"
          >保存数据库连接</ElButton
        ><ElButton
          v-if="selected"
          :disabled="scope.state.busy || dirty() || uncertain || !!remote"
          @click="toSources"
          >创建数据源</ElButton
        ><ElButton
          v-if="selected"
          type="danger"
          plain
          :disabled="scope.state.busy || !!selected.source_ids.length"
          :title="selected.source_ids.length ? '此连接正在使用，暂时无法删除。' : undefined"
          @click="remove"
          >删除连接</ElButton
        >
      </div>
      <p v-if="targets" class="management-help">
        可访问数据库：{{ targets.map((t) => t.name).join("、") || "未发现目标库" }}
      </p>
    </section>
  </section>
</template>

<style scoped>
.connection-card :deep(.management-card-facts) {
  display: none;
}
.connection-card :deep(.management-card-footer) {
  margin-top: 20px;
}
.connection-actions {
  position: static;
}
.connection-transport {
  grid-column: 1 / -1;
}
.connection-transport :deep(.el-form-item__content) {
  flex-direction: column;
  align-items: flex-start;
}
</style>
