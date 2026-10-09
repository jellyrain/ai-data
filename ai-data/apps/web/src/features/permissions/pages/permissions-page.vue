<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElSelect, ElOption, ElButton } from "element-plus";
import type { Dataset, ManagedRole, CurrentPolicyState } from "@ai-data/contracts";
import { CatalogApi } from "../../data-management/api/catalog-api";
import { PermissionsApi } from "../api/permissions-api";
import PolicyEditor from "../components/policy-editor.vue";
import PolicyHistory from "../components/policy-history.vue";
import PolicyPreview from "../components/policy-preview.vue";
import ResourceList from "../../../shared/management/resource-list.vue";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import { useManagementPage } from "../../../shared/management/use-management-page";
const sources = ref<{ source_id: string; status: string }[]>([]),
  roles = ref<ManagedRole[]>([]),
  sourceId = ref(""),
  roleId = ref(""),
  items = ref<Dataset[]>([]),
  selected = ref<Dataset | null>(null),
  current = ref<CurrentPolicyState | null>(null),
  editor = ref<InstanceType<typeof PolicyEditor>>(),
  tab = ref("rules");
const { scope } = useManagementPage(
  () => {
    sources.value = [];
    roles.value = [];
    sourceId.value = "";
    roleId.value = "";
    items.value = [];
    selected.value = null;
    current.value = null;
  },
  () => false,
);
const rows = computed(() =>
  items.value.map((item) => ({
    id: item.object_id,
    title: item.name,
    description: item.object_id,
    status: `${item.columns.length} 字段`,
  })),
);
function list() {
  return scope.run(async (request) => {
    const api = new CatalogApi(request);
    [sources.value, roles.value] = await Promise.all([api.sources(), api.roles()]);
  });
}
async function choose(source: string, role: string) {
  if (!(await (editor.value?.canLeave() ?? true))) return;
  await scope.run(async (request) => {
    const data = source ? await new CatalogApi(request).datasets(source) : [],
      state = source && role ? await new PermissionsApi(request).current(source, role) : null;
    sourceId.value = source;
    roleId.value = role;
    items.value = data;
    current.value = state;
    selected.value = null;
    tab.value = "rules";
  });
}
async function open(id: string) {
  if (!(await (editor.value?.canLeave() ?? true))) return;
  selected.value = items.value.find((item) => item.object_id === id) ?? null;
}
async function selectTab(value: string) {
  if (!(await (editor.value?.canLeave() ?? true))) return;
  tab.value = value;
}
onMounted(list);
</script>
<template>
  <section class="management-page">
    <header class="management-heading">
      <div>
        <h1>角色与数据权限</h1>
        <p class="muted">按数据源与已有角色配置对象、字段和行范围。</p>
      </div>
      <ElButton :loading="scope.state.busy" @click="list">刷新选项</ElButton>
    </header>
    <div class="management-context-bar">
      <span class="muted">权限范围</span
      ><ElSelect
        :model-value="sourceId"
        placeholder="数据源"
        aria-label="策略数据源"
        filterable
        :disabled="scope.state.busy"
        @update:model-value="choose($event, roleId)"
        ><ElOption
          v-for="source in sources"
          :key="source.source_id"
          :value="source.source_id"
          :label="source.source_id" /></ElSelect
      ><ElSelect
        :model-value="roleId"
        placeholder="已有角色"
        aria-label="策略角色"
        filterable
        :disabled="scope.state.busy"
        @update:model-value="choose(sourceId, $event)"
        ><ElOption
          v-for="role in roles"
          :key="role.id"
          :value="role.id"
          :label="`${role.name} · ${role.code}`"
      /></ElSelect>
    </div>
    <ManagementFeedback v-bind="scope.state" />
    <div v-if="current" class="management-tabs">
      <ElButton :type="tab === 'rules' ? 'primary' : 'default'" @click="selectTab('rules')"
        >当前规则</ElButton
      ><ElButton :type="tab === 'history' ? 'primary' : 'default'" @click="selectTab('history')"
        >版本历史</ElButton
      >
    </div>
    <PolicyHistory
      v-if="current && tab === 'history'"
      :key="`${sourceId}:${roleId}`"
      :source-id="sourceId"
      :role-id="roleId"
    />
    <div v-else class="management-grid">
      <ResourceList
        :items="rows"
        :selected="selected?.object_id"
        :disabled="scope.state.busy || !current"
        @select="open"
      />
      <main class="management-detail">
        <template v-if="current && selected"
          ><PolicyEditor
            :key="`${sourceId}:${roleId}:${selected.object_id}`"
            ref="editor"
            :source-id="sourceId"
            :role-id="roleId"
            :dataset="selected"
            :current="current"
            @saved="current = $event" />
          <details class="management-disclosure">
            <summary>预览权限规则</summary>
            <PolicyPreview
              :key="`preview:${sourceId}:${roleId}:${selected.object_id}`"
              :source-id="sourceId"
              :role-id="roleId"
              :object-id="selected.object_id"
              :field="selected.columns[0]?.name ?? ''"
            /></details
        ></template>
        <div v-else class="management-empty">选择数据源、角色与对象后开始配置。</div>
      </main>
    </div>
  </section>
</template>
