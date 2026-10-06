<script setup lang="ts">
import { vNumberAccessibility } from "../../../shared/management/number-accessibility";
import { computed, ref } from "vue";
import {
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElSelect,
  ElOption,
  ElButton,
} from "element-plus";
import { stableStringify, type ManagedSecretReference } from "@ai-data/contracts";
import { DataAccessApi } from "../api/data-access-api";
import {
  useManagementPage,
  confirmManagement,
} from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import { ApiError } from "../../../shared/http/api-error";
import SqlServerTransportForm from "./sqlserver-transport-form.vue";
import SqlServerTransportEditor from "./sqlserver-transport-editor.vue";
const props = defineProps<{ serviceId: string; references: ManagedSecretReference[] }>();
const emit = defineEmits<{ saved: [reference: string] }>();
const empty = () => ({
  secret_ref: "",
  connector_kind: "sqlserver",
  host: "",
  port: 1433,
  user: "",
  password: "",
});
const draft = ref(empty()),
  uncertain = ref(false);
const transport = ref({ encrypt: true, trust_server_certificate: false });
const transportEditor = ref<InstanceType<typeof SqlServerTransportEditor>>();
const existingReference = computed(() =>
  props.references.some((item) => item.secret_ref === draft.value.secret_ref && item.exists),
);
const { scope, discard } = useManagementPage(
  () => {
    draft.value = empty();
    uncertain.value = false;
    transport.value = { encrypt: true, trust_server_certificate: false };
  },
  () =>
    stableStringify(draft.value) !== stableStringify(empty()) ||
    uncertain.value ||
    (draft.value.connector_kind === "sqlserver" &&
      !existingReference.value &&
      (!transport.value.encrypt || transport.value.trust_server_certificate)),
);
async function save() {
  const sources =
    props.references.find((item) => item.secret_ref === draft.value.secret_ref)?.source_ids ?? [];
  if (
    sources.length &&
    !(await confirmManagement(
      `更新此凭据会刷新以下数据源的连接：${sources.join("、")}。`,
      "更新共享凭据",
    ))
  )
    return;
  await scope.run(async (request) => {
    try {
      const result = await new DataAccessApi(request, props.serviceId).saveSecret({
        ...draft.value,
        ...(draft.value.connector_kind === "sqlserver" && !existingReference.value
          ? { sqlserver_transport: transport.value }
          : {}),
      });
      draft.value = empty();
      transport.value = { encrypt: true, trust_server_certificate: false };
      uncertain.value = false;
      scope.state.notice = `凭据 ${result.secret_ref} 已保存。可继续发现目标库。`;
      emit("saved", result.secret_ref);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 0 || error.status >= 500) &&
        error.code !== "CANCELLED"
      ) {
        uncertain.value = true;
        scope.state.notice =
          "凭据保存结果待核对。引用存在无法验证秘密内容，可显式重新提交，或使用该引用发现目标库来验证连接。";
        return;
      }
      throw error;
    }
  });
}
async function retry() {
  if (await confirmManagement("重新提交会用本次输入更新该引用的完整凭据。", "重新提交凭据")) {
    uncertain.value = false;
    await save();
  }
}
defineExpose({
  canLeave: async () => (await discard()) && (await (transportEditor.value?.canLeave() ?? true)),
});
</script>
<template>
  <section class="management-section">
    <h3>保存数据库凭据</h3>
    <p class="muted">一个凭据引用可以用于同一服务器上的多个数据源。</p>
    <ManagementFeedback v-bind="scope.state" /><ElForm
      label-position="top"
      :disabled="scope.state.busy || uncertain"
      @submit.prevent
      ><div class="management-form-grid">
        <ElFormItem label="凭据引用" required
          ><ElInput v-model="draft.secret_ref" maxlength="256" /></ElFormItem
        ><ElFormItem label="数据库类型"
          ><ElSelect
            v-model="draft.connector_kind"
            @change="
              draft.port =
                { sqlserver: 1433, mysql: 3306, postgresql: 5432, oracle: 1521 }[
                  draft.connector_kind
                ] ?? 1433
            "
            ><ElOption
              v-for="kind in ['sqlserver', 'mysql', 'postgresql', 'oracle']"
              :key="kind"
              :label="kind"
              :value="kind" /></ElSelect></ElFormItem
        ><ElFormItem label="主机" required
          ><ElInput v-model="draft.host" autocomplete="off" /></ElFormItem
        ><ElFormItem label="端口"
          ><ElInputNumber
            v-model="draft.port"
            v-number-accessibility
            :min="1"
            :max="65535"
            :precision="0" /></ElFormItem
        ><ElFormItem label="数据库账号" required
          ><ElInput v-model="draft.user" autocomplete="off" /></ElFormItem
        ><ElFormItem label="密码" required
          ><ElInput v-model="draft.password" type="password" autocomplete="new-password"
        /></ElFormItem>
      </div>
      <template v-if="draft.connector_kind === 'sqlserver'">
        <p v-if="existingReference" class="management-help">
          此引用的连接参数在下方单独维护。更新登录凭据会保留已保存的连接参数。
        </p>
        <SqlServerTransportForm v-else v-model="transport" />
      </template> </ElForm
    ><ElButton type="primary" :loading="scope.state.busy" :disabled="uncertain" @click="save"
      >保存凭据</ElButton
    ><ElButton v-if="uncertain" @click="retry">确认重新提交</ElButton>
    <SqlServerTransportEditor
      ref="transportEditor"
      :service-id="serviceId"
      :references="references"
    />
  </section>
</template>
