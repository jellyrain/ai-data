<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElButton } from "element-plus";
import type { PolicyVersion, PolicyVersionSummary } from "@ai-data/contracts";
import { PermissionsApi } from "../api/permissions-api";
import { useManagementPage } from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
const props = defineProps<{ sourceId: string; roleId: string }>();
const items = ref<PolicyVersionSummary[]>([]),
  selected = ref<PolicyVersion | null>(null),
  more = ref(false);
const { scope } = useManagementPage(
  () => {
    items.value = [];
    selected.value = null;
    more.value = false;
  },
  () => false,
);
function load(append = false) {
  return scope.run(async (request) => {
    const list = await new PermissionsApi(request).history(
      props.sourceId,
      props.roleId,
      append ? items.value.at(-1)?.version : undefined,
    );
    items.value = append ? [...items.value, ...list] : list;
    more.value = list.length === 20;
  });
}
function open(version: number) {
  return scope.run(async (request) => {
    selected.value = await new PermissionsApi(request).version(
      props.sourceId,
      props.roleId,
      version,
    );
  });
}
onMounted(() => load());
</script>
<template>
  <section class="management-section">
    <h3>策略版本历史</h3>
    <p class="management-help">版本按组织与数据源的提交顺序生成，同一角色的版本号可能跳号。</p>
    <ManagementFeedback v-bind="scope.state" /><ElButton :loading="scope.state.busy" @click="load()"
      >刷新历史</ElButton
    >
    <div v-for="item in items" :key="item.version" class="management-section">
      <ElButton text :disabled="scope.state.busy" @click="open(item.version)"
        >v{{ item.version }} · {{ item.summary.object_id }} · {{ item.summary.kind }}</ElButton
      >
      <p class="muted">{{ item.changed_at }} · 操作者 {{ item.changed_by }}</p>
    </div>
    <p v-if="!items.length && !scope.state.busy" class="muted">
      尚无历史提交；当前规则以实际权限表为准。
    </p>
    <ElButton v-if="more" :loading="scope.state.busy" @click="load(true)">加载更早版本</ElButton>
    <pre v-if="selected" class="management-code">{{ JSON.stringify(selected, null, 2) }}</pre>
  </section>
</template>
