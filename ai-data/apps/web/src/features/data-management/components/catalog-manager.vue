<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElSelect, ElOption } from "element-plus";
import {
  stableStringify,
  type Dataset,
  type AdminDatasetDetail,
  type ManagedRole,
} from "@ai-data/contracts";
import { CatalogApi } from "../api/catalog-api";
import { catalogDraft, catalogInput } from "../stores/catalog-draft";
import type { CatalogDraft } from "../stores/catalog-draft-types";
import CatalogForm from "./catalog-form.vue";
import RelationManager from "./relation-manager.vue";
import ResourceList from "../../../shared/management/resource-list.vue";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import { ApiError } from "../../../shared/http/api-error";
const sources = ref<{ source_id: string; status: string }[]>([]),
  sourceId = ref(""),
  items = ref<Dataset[]>([]),
  roles = ref<ManagedRole[]>([]),
  selected = ref<AdminDatasetDetail | null>(null),
  draft = ref<CatalogDraft | null>(null),
  baseline = ref(""),
  remote = ref<AdminDatasetDetail | null>(null),
  relation = ref<InstanceType<typeof RelationManager>>();
const dirty = computed(() => !!draft.value && stableStringify(draft.value) !== baseline.value);
const { scope, discard } = useManagementPage(
  () => {
    sources.value = [];
    sourceId.value = "";
    items.value = [];
    roles.value = [];
    selected.value = null;
    draft.value = null;
    remote.value = null;
    baseline.value = "";
  },
  () => dirty.value,
);
async function canLeave() {
  return (await discard()) && (await (relation.value?.canLeave() ?? true));
}
const rows = computed(() =>
  items.value.map((item) => ({
    id: item.object_id,
    title: item.name,
    description: item.source_description,
    status: `${item.kind} · ${item.columns.length} 字段`,
  })),
);
function list() {
  return scope.run(async (request) => {
    const api = new CatalogApi(request);
    [sources.value, roles.value] = await Promise.all([api.sources(), api.roles()]);
  });
}
async function selectSource(value: string) {
  if (!(await canLeave())) return;
  await scope.run(async (request) => {
    const result = await new CatalogApi(request).datasets(value);
    sourceId.value = value;
    items.value = result;
    selected.value = null;
    draft.value = null;
    remote.value = null;
  });
}
function accept(detail: AdminDatasetDetail) {
  selected.value = detail;
  draft.value = catalogDraft(detail);
  baseline.value = stableStringify(draft.value);
  remote.value = null;
}
async function open(id: string) {
  if (!(await canLeave())) return;
  await scope.run(async (request) =>
    accept(await new CatalogApi(request).detail(sourceId.value, id)),
  );
}
async function save() {
  if (!selected.value || !draft.value || !(await (relation.value?.canLeave() ?? true))) return;
  await scope.run(async (request) => {
    const api = new CatalogApi(request),
      input = catalogInput(draft.value!);
    try {
      await api.save({ ...input, expected_version: selected.value!.config_version });
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        remote.value = await api.detail(sourceId.value, input.object_id);
        scope.state.notice = "配置需要核对，已读取当前服务端版本，草稿保留。";
        return;
      }
      throw error;
    }
    accept(await api.detail(sourceId.value, input.object_id));
    scope.state.notice = "业务目录配置已保存并回读。";
  });
}
async function rebase() {
  if (
    !remote.value ||
    !draft.value ||
    !(await confirmManagement(
      "保留表单内容并采用当前配置版本。关系定义将使用服务端最新关系，下一次保存更新其余完整业务配置。",
      "核对业务配置",
    ))
  )
    return;
  selected.value = remote.value;
  draft.value.config.approved_relations = remote.value.config?.approved_relations ?? [];
  remote.value = null;
}
function published() {
  if (!selected.value) return;
  return scope.run(async (request) =>
    accept(await new CatalogApi(request).detail(sourceId.value, selected.value!.dataset.object_id)),
  );
}
onMounted(list);
defineExpose({ canLeave });
</script>
<template>
  <section>
    <div class="management-toolbar">
      <ElSelect
        :model-value="sourceId"
        filterable
        placeholder="选择业务数据源"
        aria-label="业务数据源"
        :disabled="scope.state.busy"
        @update:model-value="selectSource"
        ><ElOption
          v-for="item in sources"
          :key="item.source_id"
          :value="item.source_id"
          :label="`${item.source_id} · ${item.status}`" /></ElSelect
      ><ElButton :loading="scope.state.busy" @click="list">刷新数据源</ElButton>
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-grid">
      <ResourceList
        :items="rows"
        :selected="selected?.dataset.object_id"
        :disabled="scope.state.busy"
        @select="open"
      />
      <main class="management-detail">
        <template v-if="selected && draft"
          ><h2>{{ selected.dataset.name }}</h2>
          <p class="muted">
            {{ selected.dataset.object_id }} · 配置 v{{ selected.config_version }}
          </p>
          <CatalogForm
            v-model="draft"
            :dataset="selected.dataset"
            :roles="roles"
            :disabled="scope.state.busy" />
          <div v-if="remote" role="alert">
            <h3>服务端当前配置 v{{ remote.config_version }}</h3>
            <pre class="management-code">{{ JSON.stringify(remote.config, null, 2) }}</pre>
            <ElButton @click="rebase">已核对，保留草稿采用新基准</ElButton>
          </div>
          <footer class="management-footer">
            <ElButton
              type="primary"
              :loading="scope.state.busy"
              :disabled="!!remote || (!dirty && selected.config !== null)"
              @click="save"
              >保存业务配置</ElButton
            >
          </footer>
          <RelationManager
            :key="`${sourceId}:${selected.dataset.object_id}`"
            ref="relation"
            :source-id="sourceId"
            :object-id="selected.dataset.object_id"
            :datasets="items"
            :disabled="dirty || scope.state.busy || !!remote"
            @published="published"
        /></template>
        <div v-else class="management-empty">选择数据源与对象，维护业务含义、字段策略与关系。</div>
      </main>
    </div>
  </section>
</template>
