<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElDialog } from "element-plus";
import { stableStringify, type ReportDefinitionVersion } from "@ai-data/contracts";
import { useServices } from "../../../app/services";
import { KnowledgeApi } from "../../knowledge/api/knowledge-api";
import { useManagementPage } from "../../../shared/management/use-management-page";
const props = defineProps<{ definition: ReportDefinitionVersion; disabled?: boolean }>();
const { auth } = useServices();
const canSubmit = computed(
  () =>
    props.definition.user_id === auth.state.context?.userId ||
    auth.state.context?.roles.includes("system_admin") ||
    auth.state.context?.permissions.includes("knowledge:manage"),
);
const candidateId = ref("");
const opened = ref(false);
let attempt = { content: "", id: "" };
const { scope } = useManagementPage(
  () => {
    candidateId.value = "";
    attempt = { content: "", id: "" };
  },
  () => false,
);
watch(
  () => [props.definition.report_id, props.definition.version],
  () => scope.clear(),
);
async function submit() {
  await scope.run(async (request) => {
    const definition = props.definition,
      content = stableStringify(definition.definition),
      fingerprint = definition.report_id + ":" + definition.version + ":" + content;
    if (attempt.content !== fingerprint)
      attempt = { content: fingerprint, id: crypto.randomUUID() };
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const saved = await new KnowledgeApi(request).submit({
      idempotency_key: attempt.id,
      scope: {},
      content: {
        type: "report_template",
        report_id: definition.report_id,
        definition_version: definition.version,
        definition_hash: hash,
      },
    });
    candidateId.value = saved.candidate_id;
    scope.state.notice = "已提交固定定义版本，等待负责人审核。";
  });
}
</script>
<template>
  <ElButton v-if="canSubmit" :disabled="disabled" @click="opened = true">提交为组织模板</ElButton>
  <ElDialog v-model="opened" title="提交组织模板" width="min(560px, 94vw)">
    <h3>{{ definition.definition.title }}</h3>
    <p class="muted">模板包含查询、筛选条件与展示配置，供组织成员创建自己的报表。</p>
    <p>
      提交定义 v{{ definition.version }}「{{
        definition.definition.title
      }}」，审核期间保留这个固定版本。
    </p>
    <ElButton type="primary" :loading="scope.state.busy" @click="submit">确认提交模板</ElButton>
    <p v-if="scope.state.error" role="alert">{{ scope.state.error }}</p>
    <p v-if="scope.state.notice" role="status">{{ scope.state.notice }}</p>
    <RouterLink
      v-if="candidateId"
      :to="{ path: '/knowledge', query: { tab: 'candidates', candidate: candidateId } }"
      >查看模板候选</RouterLink
    ></ElDialog
  >
</template>
