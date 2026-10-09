<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElButton, ElInput, ElCheckbox, ElPagination, ElDrawer } from "element-plus";
import {
  stableStringify,
  type ManagedSourceObjects,
  type ManageableSourceObject,
} from "@ai-data/contracts";
import { DataAccessApi } from "../api/data-access-api";
import { objectSelection, objectEdits } from "../stores/object-selection";
import type { ObjectSelection } from "../stores/object-selection-types";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import JsonField from "../../../shared/management/json-field.vue";
import QueryCapabilityEditor from "./query-capability-editor.vue";
import { validateCapabilities } from "../stores/capability-editor";
import type { QueryCapabilities } from "@ai-data/contracts";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{ serviceId: string; sourceId: string; readonly?: boolean }>();
const saved = ref<ManagedSourceObjects | null>(null),
  draft = ref<ObjectSelection[]>([]),
  available = ref<ManageableSourceObject[]>([]),
  remote = ref<ManagedSourceObjects | null>(null),
  search = ref(""),
  page = ref(1),
  selected = ref(""),
  editing = ref<ObjectSelection | null>(null),
  capabilities = ref<QueryCapabilities>(),
  procedure = ref(""),
  editBase = ref("");
const onlySelected = ref(false);
const removed = ref(new Map<string, ObjectSelection>());
const editorSnapshot = () =>
  stableStringify({
    editing: editing.value,
    capabilities: capabilities.value,
    procedure: procedure.value,
  });
const dirty = computed(
  () =>
    (!!saved.value &&
      stableStringify(draft.value) !== stableStringify(saved.value.items.map(objectSelection))) ||
    (!!editing.value && editorSnapshot() !== editBase.value),
);
const { scope, discard } = useManagementPage(
  () => {
    saved.value = null;
    draft.value = [];
    available.value = [];
    remote.value = null;
    selected.value = "";
    editing.value = null;
    capabilities.value = undefined;
    procedure.value = "";
    editBase.value = "";
    removed.value.clear();
  },
  () => dirty.value,
);
const rows = computed(() => {
  const known = new Map<string, ObjectSelection>();
  for (const item of [
    ...(saved.value?.items.map(objectSelection) ?? []),
    ...removed.value.values(),
    ...draft.value,
  ])
    known.set(item.object_id, item);
  const physical = new Set([...known.values()].map((item) => item.discovered_object_id));
  const entries = [...known.values()].map((selection) => ({
    id: selection.object_id,
    selection,
    discovered: available.value.find((item) => item.object_id === selection.discovered_object_id),
  }));
  for (const item of available.value) {
    if (!physical.has(item.object_id))
      entries.push({
        id: item.object_id,
        selection: {
          object_id: item.object_id,
          discovered_object_id: item.object_id,
          is_discoverable: true,
          is_queryable: item.kind !== "stored_procedure",
          query_capabilities: item.query_capabilities ?? {},
        },
        discovered: item,
      });
  }
  // 勾选只改变草稿，不改变对象在当前列表中的排序与分页位置。
  const positions = new Map<string | undefined, number>();
  for (const id of [
    ...(saved.value?.items.map((item) => objectSelection(item).discovered_object_id) ?? []),
    ...available.value.map((item) => item.object_id),
  ]) {
    if (!positions.has(id)) positions.set(id, positions.size);
  }
  entries.sort(
    (a, b) =>
      (positions.get(a.selection.discovered_object_id) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(b.selection.discovered_object_id) ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
  return entries.map((entry) => ({
    ...entry,
    checked: draft.value.some((item) => item.object_id === entry.id),
  }));
});
const matches = computed(() =>
  rows.value.filter(
    (row) =>
      (!onlySelected.value || row.checked) &&
      `${row.id} ${row.selection.discovered_object_id} ${row.discovered?.source_description ?? ""}`
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
  ),
);
const shown = computed(() => matches.value.slice((page.value - 1) * 20, page.value * 20));
watch([search, onlySelected], () => {
  page.value = 1;
});
watch(
  () => matches.value.length,
  (length) => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 20)));
  },
);
const kindLabel = (physical = "") =>
  ({ table: "表", view: "视图", stored_procedure: "存储过程", api_dataset: "API 数据集" })[
    physical.split(".")[0]!
  ] ?? "对象";
async function read() {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    saved.value = await new DataAccessApi(request, props.serviceId).objects(props.sourceId);
    draft.value = saved.value.items.map(objectSelection);
    remote.value = null;
    editing.value = null;
    selected.value = "";
    removed.value.clear();
  });
}
function discover() {
  return scope.run(async (request) => {
    available.value = await new DataAccessApi(request, props.serviceId).discover(props.sourceId);
    scope.state.notice = `已发现 ${available.value.length} 个对象，可直接勾选或取消。`;
  });
}
async function toggle(row: (typeof rows.value)[number], checked: unknown) {
  if (props.readonly || scope.state.busy) return;
  if (checked) {
    if (!draft.value.some((item) => item.object_id === row.id))
      draft.value.push({ ...row.selection });
  } else await remove(row.id);
}
async function open(id: string) {
  if (
    editing.value &&
    editorSnapshot() !== editBase.value &&
    !(await confirmManagement("放弃当前对象尚未应用的编辑？", "切换对象"))
  )
    return;
  const value = draft.value.find((item) => item.object_id === id);
  if (!value) return;
  selected.value = id;
  scope.state.error = "";
  editing.value = { ...value };
  capabilities.value = value.query_capabilities;
  procedure.value = value.procedure_definition
    ? JSON.stringify(value.procedure_definition, null, 2)
    : "";
  editBase.value = editorSnapshot();
  if (!editingDataset.value) await discover();
}
const editingDataset = computed(() =>
  available.value.find((item) => item.object_id === editing.value?.discovered_object_id),
);
/** 抽屉取消只放弃当前对象尚未应用的编辑；列表草稿、筛选和页码保留。 */
async function closeEditor() {
  if (scope.state.busy) return;
  if (
    editing.value &&
    editorSnapshot() !== editBase.value &&
    !(await confirmManagement("放弃当前对象尚未应用的修改？", "放弃对象编辑"))
  )
    return;
  editing.value = null;
  selected.value = "";
}
function apply() {
  const notice = scope.state.notice;
  return scope.run(async () => {
    scope.state.notice = notice;
    if (!editing.value) return;
    if (editingDataset.value)
      validateCapabilities(capabilities.value, editingDataset.value.columns);
    const value = objectEdits(editing.value, capabilities.value, procedure.value);
    if (
      draft.value.some(
        (row) => row.object_id === value.object_id && row.object_id !== selected.value,
      )
    )
      throw new ApiError("逻辑标识不能重复", 400, "INVALID_INPUT");
    draft.value = draft.value.map((row) => (row.object_id === selected.value ? value : row));
    selected.value = value.object_id;
    editing.value = null;
  });
}
async function remove(id = selected.value) {
  const value = draft.value.find((row) => row.object_id === id);
  if (!value) return;
  if (
    editing.value &&
    selected.value === id &&
    editorSnapshot() !== editBase.value &&
    !(await confirmManagement("取消选中将放弃此对象尚未应用的编辑。", "取消选中"))
  )
    return;
  removed.value.set(id, value);
  draft.value = draft.value.filter((row) => row.object_id !== id);
  if (selected.value === id) {
    editing.value = null;
    selected.value = "";
  }
}
async function save() {
  if (!saved.value) return;
  if (editing.value && editorSnapshot() !== editBase.value) {
    scope.state.error = "请先应用当前对象的编辑，再保存完整白名单。";
    return;
  }
  if (
    !draft.value.length &&
    !(await confirmManagement("保存空集合将清空该数据源的全部对象白名单。", "清空白名单"))
  )
    return;
  await scope.run(async (request) => {
    const api = new DataAccessApi(request, props.serviceId);
    try {
      await api.saveObjects({
        source_id: props.sourceId,
        objects: draft.value,
        expected_revision: saved.value!.revision,
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        remote.value = await api.objects(props.sourceId);
        scope.state.notice = "保存结果需要核对。服务端完整集合已读取，当前草稿保留。";
        return;
      }
      throw error;
    }
    saved.value = await api.objects(props.sourceId);
    draft.value = saved.value.items.map(objectSelection);
    scope.state.notice = `完整白名单已保存并回读，共 ${draft.value.length} 个对象。`;
    editing.value = null;
    removed.value.clear();
  });
}
async function rebase() {
  if (
    !remote.value ||
    !(await confirmManagement(
      "保留当前完整草稿并采用新指纹，下次保存将整体替换服务端集合。请确认已核对所有对象。",
      "核对完整白名单",
    ))
  )
    return;
  saved.value = remote.value;
  remote.value = null;
}
onMounted(read);
defineExpose({ canLeave: discard });
</script>
<template>
  <section class="object-whitelist">
    <div class="whitelist-heading">
      <div>
        <h2>对象白名单</h2>
        <p class="management-help">勾选允许使用的对象，取消勾选后保存即可移除。</p>
      </div>
      <span class="whitelist-count"
        >已选 {{ draft.length }} 项<span v-if="dirty"> · 待保存</span></span
      >
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-actions">
      <ElButton :disabled="scope.state.busy" @click="read">重新读取白名单</ElButton
      ><ElButton :loading="scope.state.busy" :disabled="readonly" @click="discover"
        >发现数据库对象</ElButton
      >
    </div>
    <div v-if="saved" class="whitelist-browser">
      <div class="whitelist-toolbar">
        <ElInput
          v-model="search"
          placeholder="搜索对象名称或物理映射"
          aria-label="搜索发现对象"
          @input="page = 1"
        />
        <ElCheckbox v-model="onlySelected">只看已选</ElCheckbox>
      </div>
      <div class="whitelist-table-wrap">
        <table class="whitelist-table" aria-label="对象白名单列表">
          <thead>
            <tr>
              <th class="whitelist-check">选择</th>
              <th>对象名称</th>
              <th class="whitelist-type">类型</th>
              <th class="whitelist-fields">字段</th>
              <th class="whitelist-action">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shown" :key="row.id" :class="{ 'is-selected': row.checked }">
              <td class="whitelist-check">
                <ElCheckbox
                  :model-value="row.checked"
                  :aria-label="`选择 ${row.id}`"
                  :disabled="readonly || scope.state.busy"
                  @change="toggle(row, $event)"
                />
              </td>
              <td class="whitelist-name">
                <strong>{{ row.id }}</strong
                ><span v-if="row.selection.discovered_object_id !== row.id">{{
                  row.selection.discovered_object_id
                }}</span>
              </td>
              <td class="whitelist-type">{{ kindLabel(row.selection.discovered_object_id) }}</td>
              <td class="whitelist-fields">{{ row.discovered?.columns.length ?? "—" }}</td>
              <td class="whitelist-action">
                <ElButton
                  v-if="row.checked"
                  text
                  :aria-label="`配置 ${row.id}`"
                  :disabled="scope.state.busy"
                  @click="open(row.id)"
                  >配置</ElButton
                ><span v-else class="muted">未选</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!matches.length" class="whitelist-empty">
          {{ rows.length ? "没有匹配的对象" : "点击“发现数据库对象”读取可选对象" }}
        </p>
      </div>
      <ElPagination
        v-if="matches.length > 20"
        v-model:current-page="page"
        :total="matches.length"
        :page-size="20"
        layout="prev,pager,next"
        small
      />
    </div>
    <ElDrawer
      :model-value="!!editing"
      :title="`配置 ${selected}`"
      size="min(600px, 100vw)"
      append-to-body
      :before-close="closeEditor"
      class="whitelist-editor-drawer"
    >
      <section v-if="editing && saved" class="whitelist-editor">
        <p class="muted">物理映射：{{ editing.discovered_object_id }}</p>
        <p class="management-help">应用修改后，点击列表中的“保存完整白名单”使配置生效。</p>
        <ManagementFeedback :error="scope.state.error" notice="" :busy="scope.state.busy" />
        <label
          >逻辑对象标识<ElInput
            v-model="editing.object_id"
            :disabled="
              readonly ||
              scope.state.busy ||
              saved.items.some((item) => item.object_id === selected)
            "
        /></label>
        <div class="management-toolbar">
          <ElCheckbox v-model="editing.is_discoverable" :disabled="readonly || scope.state.busy"
            >允许发现</ElCheckbox
          ><ElCheckbox v-model="editing.is_queryable" :disabled="readonly || scope.state.busy"
            >允许查询</ElCheckbox
          >
        </div>
        <QueryCapabilityEditor
          v-model="capabilities"
          :columns="editingDataset?.columns ?? []"
          :ready="!!editingDataset"
          :disabled="readonly || scope.state.busy"
        />
        <ElButton v-if="!editingDataset" :loading="scope.state.busy" @click="discover"
          >重新读取字段</ElButton
        >
        <JsonField
          v-if="editing.discovered_object_id?.startsWith('stored_procedure.')"
          v-model="procedure"
          label="存储过程完整定义"
          hint="依据真实签名填写严格定义。清空后只允许发现；保存时由服务器校验完整定义。"
          :disabled="readonly || scope.state.busy"
        />
      </section>
      <template #footer>
        <div class="whitelist-editor-actions">
          <ElButton :disabled="readonly || scope.state.busy" @click="remove()">取消选中</ElButton>
          <div>
            <ElButton :disabled="scope.state.busy" @click="closeEditor">取消</ElButton>
            <ElButton type="primary" :disabled="readonly || scope.state.busy" @click="apply"
              >应用对象编辑</ElButton
            >
          </div>
        </div>
      </template>
    </ElDrawer>
    <div v-if="remote" role="alert" class="management-section">
      <h3>服务端完整白名单（{{ remote.items.length }} 项）</h3>
      <pre class="management-code">{{ JSON.stringify(remote.items, null, 2) }}</pre>
      <ElButton @click="rebase">已核对，保留草稿采用新基准</ElButton>
    </div>
    <footer class="management-footer">
      <ElButton
        type="primary"
        :disabled="readonly || !saved || !!remote || !dirty"
        :loading="scope.state.busy"
        @click="save"
        >保存完整白名单</ElButton
      >
    </footer>
  </section>
</template>
<style scoped>
.whitelist-editor {
  display: grid;
  gap: 20px;
}
.whitelist-editor > p {
  margin: 0;
  overflow-wrap: anywhere;
}
.whitelist-editor > label {
  display: grid;
  gap: 8px;
}
.whitelist-editor-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
:global(.whitelist-editor-drawer .el-drawer__header) {
  margin-bottom: 0;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--app-border);
  overflow-wrap: anywhere;
}
:global(.whitelist-editor-drawer .el-drawer__footer) {
  border-top: 1px solid var(--app-border);
}
.whitelist-heading,
.whitelist-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.whitelist-heading {
  margin-bottom: 20px;
}
.whitelist-heading h2 {
  margin: 0;
}
.whitelist-heading .management-help {
  margin-bottom: 0;
}
.whitelist-count {
  white-space: nowrap;
  color: var(--app-muted);
  font-size: 13px;
}
.whitelist-browser {
  margin-top: 24px;
}
.whitelist-toolbar {
  margin-bottom: 16px;
}
.whitelist-toolbar .el-input {
  max-width: 420px;
}
.whitelist-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}
.whitelist-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
}
.whitelist-table th {
  text-align: left;
  font-weight: 500;
  color: var(--app-muted);
  background: var(--app-surface);
}
.whitelist-table th,
.whitelist-table td {
  padding: 12px 16px;
  border-bottom: 1px solid var(--app-border);
  vertical-align: middle;
}
.whitelist-table tr:last-child td {
  border-bottom: 0;
}
.whitelist-table tbody tr:hover {
  background: var(--app-hover);
}
.whitelist-check {
  width: 62px;
}
.whitelist-type {
  width: 100px;
}
.whitelist-fields {
  width: 64px;
}
.whitelist-action {
  width: 82px;
}
.whitelist-name strong {
  display: block;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.whitelist-name span {
  display: block;
  margin-top: 4px;
  color: var(--app-muted);
  overflow-wrap: anywhere;
}
.whitelist-empty {
  padding: 24px 16px;
  margin: 0;
  text-align: center;
  color: var(--app-muted);
}
.whitelist-browser .el-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}
@media (max-width: 640px) {
  .whitelist-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .whitelist-toolbar {
    flex-wrap: wrap;
    gap: 8px;
  }
  .whitelist-table th,
  .whitelist-table td {
    padding: 10px 8px;
  }
  .whitelist-check {
    width: 44px;
  }
  .whitelist-type,
  .whitelist-fields {
    display: none;
  }
  .whitelist-action {
    width: 58px;
  }
}
</style>
