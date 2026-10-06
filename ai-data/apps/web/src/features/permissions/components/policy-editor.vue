<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ElButton,
  ElForm,
  ElFormItem,
  ElInput,
  ElSelect,
  ElOption,
  ElCheckbox,
  ElCheckboxGroup,
} from "element-plus";
import { stableStringify, type CurrentPolicyState, type Dataset } from "@ai-data/contracts";
import { PermissionsApi } from "../api/permissions-api";
import { policyDraft, policyInput } from "../stores/policy-draft";
import type { PolicyDraft } from "../stores/policy-draft-types";
import { useManagementPage } from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{
  sourceId: string;
  roleId: string;
  dataset: Dataset;
  current: CurrentPolicyState;
}>();
const emit = defineEmits<{ saved: [current: CurrentPolicyState] }>();
const current = ref(props.current),
  remote = ref<CurrentPolicyState | null>(null),
  draft = ref(
    policyDraft(
      props.current,
      props.dataset.object_id,
      props.dataset.columns[0]?.name ?? "",
      "object",
    ),
  ),
  baseline = ref(stableStringify(draft.value));
const { scope, discard } = useManagementPage(
  () => {
    remote.value = null;
    current.value = {
      version: 0,
      snapshot: { object_permissions: [], column_permissions: [], row_policies: [] },
    };
    draft.value = policyDraft(current.value, "", "", "object");
    baseline.value = "";
  },
  () => stableStringify(draft.value) !== baseline.value,
);
const rules = computed(() => ({
  object_permissions: current.value.snapshot.object_permissions.filter(
    (row) => row.object_id === props.dataset.object_id,
  ),
  column_permissions: current.value.snapshot.column_permissions.filter(
    (row) => row.object_id === props.dataset.object_id,
  ),
  row_policies: current.value.snapshot.row_policies.filter(
    (row) => row.object_id === props.dataset.object_id,
  ),
}));
async function changeKind(kind: PolicyDraft["kind"]) {
  if (!(await discard())) return;
  draft.value = policyDraft(current.value, props.dataset.object_id, draft.value.column, kind);
  baseline.value = stableStringify(draft.value);
}
async function changeColumn(column: string) {
  if (!(await discard())) return;
  draft.value = policyDraft(current.value, props.dataset.object_id, column, draft.value.kind);
  baseline.value = stableStringify(draft.value);
}
function save() {
  return scope.run(async (request) => {
    const api = new PermissionsApi(request);
    try {
      await api.save(
        draft.value.kind,
        policyInput(
          draft.value,
          props.sourceId,
          props.roleId,
          props.dataset.object_id,
          current.value.version,
        ),
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        remote.value = await api.current(props.sourceId, props.roleId);
        scope.state.notice = "规则保存需要核对，服务端当前规则已读取，草稿保留。";
        return;
      }
      throw error;
    }
    current.value = await api.current(props.sourceId, props.roleId);
    draft.value = policyDraft(
      current.value,
      props.dataset.object_id,
      draft.value.column,
      draft.value.kind,
    );
    baseline.value = stableStringify(draft.value);
    scope.state.notice = `规则已保存，当前角色策略版本为 ${current.value.version}。`;
    emit("saved", current.value);
  });
}
defineExpose({ canLeave: discard });
</script>
<template>
  <section>
    <h2>{{ dataset.name }} · 当前策略 v{{ current.version }}</h2>
    <details class="management-section">
      <summary>此对象当前生效规则</summary>
      <pre class="management-code">{{ JSON.stringify(rules, null, 2) }}</pre>
    </details>
    <div class="management-tabs">
      <ElButton
        v-for="item in [
          { id: 'object', label: '对象权限' },
          { id: 'column', label: '字段操作' },
          { id: 'row', label: '行范围' },
        ] as const"
        :key="item.id"
        :type="draft.kind === item.id ? 'primary' : 'default'"
        :disabled="scope.state.busy"
        @click="changeKind(item.id)"
        >{{ item.label }}</ElButton
      >
    </div>
    <ManagementFeedback v-bind="scope.state" /><ElForm
      label-position="top"
      :disabled="scope.state.busy"
      @submit.prevent
      ><ElFormItem v-if="draft.kind === 'column'" label="字段"
        ><ElSelect :model-value="draft.column" filterable @update:model-value="changeColumn"
          ><ElOption
            v-for="column in dataset.columns"
            :key="column.name"
            :label="column.name"
            :value="column.name" /></ElSelect></ElFormItem
      ><ElFormItem v-if="draft.kind !== 'row'" label="访问规则"
        ><ElSelect v-model="draft.effect"
          ><ElOption value="allow" label="允许" /><ElOption value="deny" label="拒绝" /></ElSelect
      ></ElFormItem>
      <section
        v-if="draft.kind === 'column' && draft.effect === 'allow'"
        class="management-section"
      >
        <ElCheckbox v-model="draft.allOperations">允许所有字段操作</ElCheckbox
        ><ElCheckboxGroup v-if="!draft.allOperations" v-model="draft.operations"
          ><ElCheckbox
            v-for="item in [
              { id: 'select', label: '返回' },
              { id: 'filter', label: '过滤' },
              { id: 'group', label: '分组' },
              { id: 'sort', label: '排序' },
              { id: 'join', label: '关联' },
            ]"
            :key="item.id"
            :value="item.id"
            >{{ item.label }}</ElCheckbox
          ></ElCheckboxGroup
        >
      </section>
      <template v-if="draft.kind === 'row'"
        ><p class="management-help">
          保存会替换该角色在此对象上的一条行条件。依赖用户或部门的规则，应使用实际业务账号查询验证。
        </p>
        <ElFormItem label="行范围字段"
          ><ElSelect v-model="draft.rowField" filterable
            ><ElOption
              v-for="column in dataset.columns"
              :key="column.name"
              :label="column.name"
              :value="column.name" /></ElSelect></ElFormItem
        ><ElFormItem label="条件"
          ><ElSelect v-model="draft.rowOp"
            ><ElOption
              v-for="op in ['eq', 'neq', 'in', 'not_in', 'between', 'is_null', 'not_null']"
              :key="op"
              :label="op"
              :value="op" /></ElSelect></ElFormItem
        ><template v-if="!['is_null', 'not_null'].includes(draft.rowOp)"
          ><ElFormItem label="取值方式"
            ><ElSelect v-model="draft.valueSource"
              ><ElOption value="literal" label="固定值" /><ElOption
                value="context"
                label="当前权限上下文"
                :disabled="draft.rowOp === 'between'" /></ElSelect></ElFormItem
          ><ElFormItem v-if="draft.valueSource === 'context'" label="可信上下文"
            ><ElSelect v-model="draft.context"
              ><ElOption
                value="permission_context.department_ids"
                label="用户业务部门 ID 集合" /><ElOption
                value="permission_context.user_id"
                label="当前用户 ID" /><ElOption
                value="permission_context.organization_id"
                label="当前组织 ID" /></ElSelect></ElFormItem
          ><ElFormItem v-else label="固定值（JSON）"
            ><ElInput v-model="draft.literal" placeholder='例如 "内科"、100、["D01","D02"]' />
            <p class="management-help">
              字符串使用双引号，集合使用数组，between 使用两个端点。
            </p></ElFormItem
          ></template
        ></template
      ></ElForm
    >
    <div v-if="remote" role="alert" class="management-section">
      <h3>服务端当前策略 v{{ remote.version }}</h3>
      <pre class="management-code">{{ JSON.stringify(remote.snapshot, null, 2) }}</pre>
      <ElButton
        @click="
          current = remote;
          remote = null;
        "
        >已核对，保留草稿采用新基准</ElButton
      >
    </div>
    <footer class="management-footer">
      <ElButton type="primary" :loading="scope.state.busy" :disabled="!!remote" @click="save"
        >保存{{
          draft.kind === "object" ? "对象权限" : draft.kind === "column" ? "字段权限" : "行范围"
        }}</ElButton
      >
    </footer>
  </section>
</template>
