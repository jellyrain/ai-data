<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInput, ElCheckbox, ElPagination } from "element-plus";
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
import ResourceList from "../../../shared/management/resource-list.vue";
import JsonField from "../../../shared/management/json-field.vue";
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
  capabilities = ref("{}"),
  procedure = ref(""),
  editBase = ref("");
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
    capabilities.value = "{}";
    procedure.value = "";
    editBase.value = "";
  },
  () => dirty.value,
);
const rows = computed(() =>
  draft.value.map((item) => ({
    id: item.object_id,
    title: item.object_id,
    description: item.discovered_object_id,
    status: item.is_queryable ? "可查询" : "仅发现",
  })),
);
const matches = computed(() =>
  available.value.filter((item) =>
    `${item.object_id} ${item.source_description ?? ""}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const shown = computed(() => matches.value.slice((page.value - 1) * 20, page.value * 20));
async function read() {
  if (!(await discard())) return;
  await scope.run(async (request) => {
    saved.value = await new DataAccessApi(request, props.serviceId).objects(props.sourceId);
    draft.value = saved.value.items.map(objectSelection);
    remote.value = null;
    editing.value = null;
    selected.value = "";
  });
}
function discover() {
  return scope.run(async (request) => {
    available.value = await new DataAccessApi(request, props.serviceId).discover(props.sourceId);
    scope.state.notice = `已发现 ${available.value.length} 个对象。已有白名单仍保留在下方，可逐项添加。`;
  });
}
function add(item: ManageableSourceObject) {
  if (draft.value.some((row) => row.discovered_object_id === item.object_id)) return;
  draft.value.push({
    object_id: item.object_id,
    discovered_object_id: item.object_id,
    is_discoverable: true,
    is_queryable: item.kind !== "stored_procedure",
    query_capabilities: item.query_capabilities ?? {},
  });
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
  editing.value = { ...value };
  capabilities.value = JSON.stringify(value.query_capabilities ?? {}, null, 2);
  procedure.value = value.procedure_definition
    ? JSON.stringify(value.procedure_definition, null, 2)
    : "";
  editBase.value = editorSnapshot();
}
function apply() {
  return scope.run(async () => {
    if (!editing.value) return;
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
async function remove() {
  if (
    !selected.value ||
    !(await confirmManagement(
      `从完整白名单移除 ${selected.value}？保存后该对象将不可用于查询。`,
      "移除对象",
    ))
  )
    return;
  draft.value = draft.value.filter((row) => row.object_id !== selected.value);
  editing.value = null;
  selected.value = "";
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
  <section class="management-section">
    <h3>对象白名单</h3>
    <p class="management-help">
      保存会替换完整集合。已有逻辑标识、物理映射、开关、能力及过程定义随未编辑对象一起保留。
    </p>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-actions">
      <ElButton :disabled="scope.state.busy" @click="read">重新读取白名单</ElButton
      ><ElButton :loading="scope.state.busy" :disabled="readonly" @click="discover"
        >发现数据库对象</ElButton
      >
    </div>
    <div v-if="available.length" class="management-section">
      <ElInput
        v-model="search"
        placeholder="搜索发现的对象"
        aria-label="搜索发现对象"
        @input="page = 1"
      />
      <div class="management-list-items">
        <div v-for="item in shown" :key="item.object_id" class="management-inline-row">
          <span class="management-resource-description"
            >{{ item.object_id }} · {{ item.columns.length }} 个字段</span
          ><ElButton
            :disabled="
              scope.state.busy || draft.some((row) => row.discovered_object_id === item.object_id)
            "
            @click="add(item)"
            >加入白名单</ElButton
          >
        </div>
      </div>
      <ElPagination
        v-model:current-page="page"
        :total="matches.length"
        :page-size="20"
        layout="prev,pager,next"
        small
      />
    </div>
    <div v-if="saved" class="management-section">
      <ResourceList
        :items="rows"
        :selected="selected"
        :disabled="scope.state.busy"
        @select="open"
      />
      <section v-if="editing" class="management-section">
        <h3>{{ selected }}</h3>
        <p class="muted">物理映射：{{ editing.discovered_object_id }}</p>
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
        <JsonField
          v-model="capabilities"
          label="查询能力"
          hint="使用 sortable_fields、groupable_fields、filter_conditions、aggregations。省略字段继承，空数组表示禁用该能力。"
          :disabled="readonly || scope.state.busy"
        /><JsonField
          v-if="editing.discovered_object_id?.startsWith('stored_procedure.')"
          v-model="procedure"
          label="存储过程完整定义"
          hint="依据真实签名填写严格定义。清空后只允许发现；保存时由服务器校验完整定义。"
          :disabled="readonly || scope.state.busy"
        />
        <div class="management-actions">
          <ElButton :disabled="readonly || scope.state.busy" @click="apply">应用对象编辑</ElButton
          ><ElButton :disabled="readonly || scope.state.busy" @click="remove">移除对象</ElButton>
        </div>
      </section>
    </div>
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
