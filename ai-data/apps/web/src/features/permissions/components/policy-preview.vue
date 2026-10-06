<script setup lang="ts">
import { ref } from "vue";
import { ElButton } from "element-plus";
import { PermissionsApi } from "../api/permissions-api";
import { parseManagementJson } from "../../data-management/stores/object-selection";
import { useManagementPage } from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import JsonField from "../../../shared/management/json-field.vue";
const props = defineProps<{ sourceId: string; roleId: string; objectId: string; field: string }>();
const query = ref(
    JSON.stringify(
      {
        type: "relational_query",
        source_id: props.sourceId,
        from: { object_id: props.objectId, alias: "t" },
        select: [{ field: `t.${props.field}` }],
        limit: 10,
      },
      null,
      2,
    ),
  ),
  result = ref("");
const { scope } = useManagementPage(
  () => {
    query.value = "";
    result.value = "";
  },
  () => false,
);
function preview() {
  return scope.run(async (request) => {
    result.value = JSON.stringify(
      await new PermissionsApi(request).preview({
        role_id: props.roleId,
        query: parseManagementJson(query.value, "受控 DSL"),
      }),
      null,
      2,
    );
  });
}
</script>
<template>
  <section class="management-section">
    <h3>预览权限规则</h3>
    <p class="management-help">
      展示授权后的 DSL 与输出脱敏规则。实际数据范围通过业务账号的分析或报表查询验证。
    </p>
    <JsonField
      v-model="query"
      label="待预览的受控 DSL"
      :disabled="scope.state.busy"
      :rows="9"
    /><ElButton :loading="scope.state.busy" @click="preview">预览权限规则</ElButton
    ><ManagementFeedback v-bind="scope.state" />
    <pre v-if="result" class="management-code">{{ result }}</pre>
  </section>
</template>
