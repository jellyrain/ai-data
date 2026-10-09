<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElSelect, ElOption, ElInput } from "element-plus";
import {
  stableStringify,
  type ManagedUser,
  type ManagedUserAuthorization,
  type UserAssignmentOptions,
  type CreateManagedUser,
} from "@ai-data/contracts";
import { UserApi } from "../api/user-api";
import UserCreateForm from "../components/user-create-form.vue";
import { Search, X } from "lucide-vue-next";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { ApiError } from "../../../shared/http/api-error";
const empty = (): CreateManagedUser => ({
  username: "",
  display_name: "",
  password: "",
  role_ids: [],
  exception_data_scope_ids: [],
});
const items = ref<ManagedUser[]>([]),
  selected = ref<ManagedUser | null>(null),
  authorization = ref<ManagedUserAuthorization | null>(null),
  options = ref<UserAssignmentOptions>({
    roles: [],
    exception_data_scopes: [],
    department_ids: [],
  }),
  draft = ref(empty()),
  creating = ref(false),
  baseline = ref(""),
  departments = ref<string[]>([]),
  conflict = ref<ManagedUserAuthorization | null>(null),
  uncertain = ref(false);
const dirty = computed(() =>
  creating.value
    ? stableStringify(draft.value) !== baseline.value
    : !!authorization.value &&
      stableStringify([...departments.value].sort()) !==
        stableStringify([...authorization.value.department_ids].sort()),
);
const { scope, discard } = useManagementPage(
  () => {
    items.value = [];
    selected.value = null;
    authorization.value = null;
    options.value = { roles: [], exception_data_scopes: [], department_ids: [] };
    draft.value = empty();
    creating.value = false;
    departments.value = [];
    conflict.value = null;
    uncertain.value = false;
    baseline.value = "";
  },
  () => dirty.value || uncertain.value,
);
const search = ref(""),
  status = ref("all");
const visible = computed(() =>
  items.value.filter(
    (item) =>
      (status.value === "all" || item.status === status.value) &&
      (item.display_name + " " + item.username)
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const statusLabel = (value: string) =>
  value === "active" ? "正常" : value === "disabled" ? "停用" : "待激活";
async function closeDetails() {
  if (!(await discard())) return;
  selected.value = null;
  authorization.value = null;
  creating.value = false;
  draft.value = empty();
  departments.value = [];
  conflict.value = null;
  uncertain.value = false;
}
function list() {
  return scope.run(async (request) => {
    const api = new UserApi(request);
    [items.value, options.value] = await Promise.all([api.list(), api.options()]);
  });
}
async function open(id: string) {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    const api = new UserApi(request);
    const [user, auth] = await Promise.all([api.get(id), api.authorization(id)]);
    selected.value = user;
    authorization.value = auth;
    departments.value = [...auth.department_ids];
    creating.value = false;
    draft.value = empty();
    conflict.value = null;
    uncertain.value = false;
  });
}
async function create() {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    options.value = await new UserApi(request).options();
    selected.value = null;
    authorization.value = null;
    draft.value = empty();
    creating.value = true;
    baseline.value = stableStringify(draft.value);
    uncertain.value = false;
  });
}
function save() {
  return scope.run(async (request) => {
    const api = new UserApi(request);
    let user: ManagedUser;
    try {
      user = await api.create(draft.value);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        uncertain.value = true;
        scope.state.notice = "创建结果待核对，请按登录名读取当前组织的账号，确认前请勿再次创建。";
        return;
      }
      throw error;
    }
    draft.value = empty();
    creating.value = false;
    selected.value = user;
    authorization.value = await api.authorization(user.id);
    departments.value = [...authorization.value.department_ids];
    items.value = await api.list();
    scope.state.notice = "账号已创建，可继续配置业务部门范围。";
  });
}
function checkCreation() {
  return scope.run(async (request) => {
    const api = new UserApi(request);
    items.value = await api.list();
    const found = items.value.find((item) => item.username === draft.value.username.trim());
    if (found) {
      selected.value = found;
      authorization.value = await api.authorization(found.id);
      departments.value = [...authorization.value.department_ids];
      draft.value = empty();
      creating.value = false;
      uncertain.value = false;
      scope.state.notice =
        "已找到同登录名账号，请核对其角色和部门资料。初始密码的实际值需要使用账号登录验证。";
    } else
      scope.state.notice = "本次读取尚未找到账号。请确认服务已完成处理，再显式决定是否重新提交。";
  });
}
async function allowRetry() {
  if (
    !(await confirmManagement(
      "已经读取列表仍未发现账号，确认重新提交创建？服务器会再次检查组织内登录名。",
      "重新提交创建",
    ))
  )
    return;
  uncertain.value = false;
}
async function saveDepartments() {
  const user = selected.value,
    auth = authorization.value;
  if (!user || !auth) return;
  if (
    !departments.value.length &&
    !(await confirmManagement(
      "保存后该账号的业务部门范围为空，依赖部门的查询范围将变化。",
      "清空部门范围",
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new UserApi(request);
    try {
      await api.departments(user.id, {
        department_ids: departments.value,
        expected_authorization_version: auth.authorization_version,
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        conflict.value = await api.authorization(user.id);
        scope.state.notice = "授权资料已重新读取，草稿保留在表单中。请比较当前部门后再保存。";
        return;
      }
      throw error;
    }
    authorization.value = await api.authorization(user.id);
    departments.value = [...authorization.value.department_ids];
    selected.value = await api.get(user.id);
    items.value = await api.list();
    scope.state.notice = "业务部门范围已保存并回读。";
  });
}
async function toggle() {
  const user = selected.value;
  if (
    !user ||
    !(await confirmManagement(
      user.status === "active" ? "停用将使该账号的现有登录失效。" : "启用后该账号可以重新登录。",
      `${user.status === "active" ? "停用" : "启用"} ${user.display_name}`,
    ))
  )
    return;
  await scope.run(async (request) => {
    const api = new UserApi(request);
    try {
      await api.status(user.id, user.status !== "active");
    } catch (error) {
      selected.value = await api.get(user.id);
      if (selected.value.status === user.status) throw error;
    }
    selected.value = await api.get(user.id);
    authorization.value = await api.authorization(user.id);
    items.value = await api.list();
  });
}
onMounted(list);
</script>
<template>
  <section class="management-page">
    <header class="management-heading">
      <div>
        <h1>用户管理</h1>
        <p class="muted">维护组织账号，查看授权资料与业务部门范围。</p>
      </div>
      <div class="management-actions">
        <ElButton :disabled="scope.state.busy" @click="list">刷新列表</ElButton
        ><ElButton type="primary" :disabled="scope.state.busy" @click="create">创建用户</ElButton>
      </div>
    </header>
    <ManagementFeedback v-bind="scope.state" />

    <div class="management-browse-toolbar">
      <ElInput v-model="search" clearable aria-label="搜索用户" placeholder="搜索姓名或账号"
        ><template #prefix><Search :size="16" /></template
      ></ElInput>
      <ElSelect v-model="status" aria-label="账号状态"
        ><ElOption label="全部状态" value="all" /><ElOption label="正常" value="active" /><ElOption
          label="停用"
          value="disabled" /><ElOption label="待激活" value="pending"
      /></ElSelect>
      <span class="muted">当前 {{ visible.length }} 位用户</span>
    </div>
    <div class="management-user-layout">
      <div class="management-table-wrap">
        <table class="management-table" aria-label="用户账号">
          <thead>
            <tr>
              <th>姓名</th>
              <th class="account-id">账号</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in visible"
              :key="item.id"
              :class="{ 'is-selected': selected?.id === item.id }"
            >
              <td>
                <button
                  class="management-account"
                  :disabled="scope.state.busy"
                  @click="open(item.id)"
                >
                  <span class="management-avatar" aria-hidden="true">{{
                    item.display_name.slice(0, 1)
                  }}</span
                  ><strong>{{ item.display_name }}</strong>
                </button>
              </td>
              <td class="account-id">{{ item.username }}</td>
              <td>
                <span class="management-badge" :class="{ 'is-active': item.status === 'active' }">{{
                  statusLabel(item.status)
                }}</span>
              </td>
              <td>
                <ElButton
                  text
                  :disabled="scope.state.busy"
                  :aria-label="'查看 ' + item.display_name"
                  @click="open(item.id)"
                  >查看</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!visible.length" class="management-empty">
          {{ scope.state.busy ? "正在读取用户…" : "没有匹配的用户" }}
        </p>
      </div>
      <aside
        v-if="selected || creating"
        class="management-panel management-user-detail"
        role="region"
        aria-label="用户详情"
      >
        <div class="management-panel-heading">
          <span v-if="selected" class="management-avatar is-large">{{
            selected.display_name.slice(0, 1)
          }}</span>
          <div>
            <h2>{{ creating ? "创建用户" : selected?.display_name }}</h2>
            <p v-if="selected" class="management-help">{{ selected.username }}</p>
          </div>
          <ElButton
            text
            class="management-close"
            :disabled="scope.state.busy"
            aria-label="关闭用户详情"
            @click="closeDetails"
            ><X :size="18"
          /></ElButton>
        </div>
        <template v-if="creating">
          <UserCreateForm
            v-model="draft"
            :options="options"
            :disabled="scope.state.busy || uncertain"
          />
          <footer class="management-footer">
            <ElButton type="primary" :loading="scope.state.busy" :disabled="uncertain" @click="save"
              >创建账号</ElButton
            ><ElButton v-if="uncertain" :disabled="scope.state.busy" @click="checkCreation"
              >按登录名核对结果</ElButton
            ><ElButton v-if="uncertain" :disabled="scope.state.busy" @click="allowRetry"
              >核对后重新提交</ElButton
            >
          </footer></template
        >
        <template v-else-if="selected && authorization">
          <dl class="management-definition">
            <dt>登录名</dt>
            <dd>{{ selected.username }}</dd>
            <dt>状态</dt>
            <dd>
              {{
                selected.status === "active"
                  ? "正常"
                  : selected.status === "disabled"
                    ? "停用"
                    : "待激活"
              }}
            </dd>
            <dt>角色</dt>
            <dd>
              <p v-for="role in authorization.roles" :key="role.id">
                {{ role.name }} · {{ role.code }} {{ role.is_privileged ? "（管理权限）" : "" }}
              </p>
              <span v-if="!authorization.roles.length">未分配角色</span>
            </dd>
            <dt>个人例外范围</dt>
            <dd>
              <p v-for="item in authorization.exception_data_scopes" :key="item.id">
                {{ item.resource }}.{{ item.field }} {{ item.operator }} {{ item.value }}
              </p>
              <span v-if="!authorization.exception_data_scopes.length">无</span>
            </dd>
            <dt>授权版本</dt>
            <dd>{{ authorization.authorization_version }}</dd>
          </dl>
          <section class="management-section">
            <h3>业务部门 ID</h3>
            <p class="management-help">
              选择组织已有 ID，或输入业务库中的部门 ID 后按回车。保存时整体替换该账号的部门范围。
            </p>
            <ElSelect
              v-model="departments"
              multiple
              filterable
              allow-create
              default-first-option
              :disabled="scope.state.busy"
              aria-label="业务部门 ID"
              ><ElOption
                v-for="id in [
                  ...new Set([...options.department_ids, ...authorization.department_ids]),
                ]"
                :key="id"
                :value="id"
                :label="id"
            /></ElSelect>
            <div v-if="conflict" role="alert" class="management-section">
              <p>
                服务端当前版本：{{ conflict.authorization_version }}；当前部门：{{
                  conflict.department_ids.join("、") || "空集合"
                }}
              </p>
              <ElButton
                @click="
                  authorization = conflict;
                  conflict = null;
                "
                >已核对，保留草稿采用新基准</ElButton
              ><ElButton
                @click="
                  authorization = conflict;
                  departments = [...conflict.department_ids];
                  conflict = null;
                "
                >采用服务端部门</ElButton
              >
            </div>
          </section>
          <footer class="management-footer">
            <ElButton
              type="primary"
              :loading="scope.state.busy"
              :disabled="!!conflict || !dirty"
              @click="saveDepartments"
              >保存部门范围</ElButton
            >
          </footer>
          <div class="management-danger-zone">
            <ElButton
              text
              :type="selected.status === 'active' ? 'danger' : 'primary'"
              :disabled="scope.state.busy || dirty"
              @click="toggle"
              >{{ selected.status === "active" ? "停用账号" : "启用账号" }}</ElButton
            >
          </div></template
        >
        <div v-else class="management-empty">选择用户查看授权资料，或创建新账号。</div>
      </aside>
    </div>
  </section>
</template>
