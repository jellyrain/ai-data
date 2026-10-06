<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { ElDialog, ElButton, ElInput, ElSelect, ElOption } from "element-plus";
import { savedReportSchema } from "@ai-data/contracts";
import type { QueryEvidence } from "@ai-data/contracts";
import { useServices } from "../../../app/services";
import { selectedResultReport } from "../models/selected-result";
import { reportError } from "../stores/report-workspace";
import { ApiError } from "../../../shared/http/api-error";
const props = defineProps<{ evidence: QueryEvidence }>();
const emit = defineEmits<{ close: [] }>();
const services = useServices();
const title = ref(""),
  description = ref(""),
  kind = ref<"table" | "line" | "bar" | "pie">("table"),
  x = ref(props.evidence.result.columns[0]?.name ?? ""),
  y = ref(
    props.evidence.result.columns.find((column) =>
      ["integer", "decimal"].includes(column.data_type),
    )?.name ?? "",
  );
const saving = ref(false),
  error = ref(""),
  savedId = ref(""),
  uncertain = ref(false);
const numeric = computed(() =>
  props.evidence.result.columns.filter((column) =>
    ["integer", "decimal"].includes(column.data_type),
  ),
);
const controller = new AbortController();
const unregister = services.resources.register(() => {
  controller.abort();
  emit("close");
});
onBeforeUnmount(() => {
  controller.abort();
  unregister();
});
async function save() {
  if (saving.value || savedId.value || uncertain.value) return;
  saving.value = true;
  error.value = "";
  try {
    const body = selectedResultReport(
      props.evidence,
      title.value,
      description.value,
      kind.value === "table" ? undefined : { type: kind.value, x: x.value, y: y.value },
    );
    const result = savedReportSchema.parse(
      await services.request("/api/reports", { method: "POST", body, signal: controller.signal }),
    );
    if (controller.signal.aborted) return;
    if (
      result.organization_id !== services.auth.state.context?.organizationId ||
      result.user_id !== services.auth.state.context?.userId
    )
      throw new ApiError("报表归属不一致", 403);
    savedId.value = result.report_id;
  } catch (failure) {
    if (!controller.signal.aborted) {
      error.value = reportError(failure);
      uncertain.value = !(
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500
      );
    }
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <ElDialog
    :model-value="true"
    title="保存为报表"
    width="min(560px, 94vw)"
    :close-on-click-modal="false"
    :show-close="!saving"
    :close-on-press-escape="!saving"
    @close="emit('close')"
  >
    <form class="report-metadata-form" @submit.prevent="save">
      <p class="muted">
        已选择一份查询结果 · {{ evidence.result.columns.length }} 列 ·
        {{ evidence.result.row_count.toLocaleString() }} 行
      </p>
      <label
        >报表名称<ElInput
          v-model="title"
          aria-label="报表名称"
          placeholder="例如：门诊趋势分析"
          :maxlength="512"
          :disabled="saving || !!savedId || uncertain"
      /></label>
      <label
        >简短说明<ElInput
          v-model="description"
          aria-label="简短说明"
          type="textarea"
          :maxlength="1000"
          :disabled="saving || !!savedId || uncertain"
      /></label>
      <label
        >展示方式<ElSelect
          v-model="kind"
          aria-label="保存展示方式"
          :disabled="saving || !!savedId || uncertain"
          ><ElOption label="明细表" value="table" /><ElOption
            v-for="option in [
              { value: 'line', label: '折线图' },
              { value: 'bar', label: '柱状图' },
              { value: 'pie', label: '饼图' },
            ]"
            :key="option.value"
            :value="option.value"
            :label="option.label"
            :disabled="!numeric.length" /></ElSelect
      ></label>
      <div v-if="kind !== 'table'" class="editor-grid">
        <label
          >维度<ElSelect v-model="x" aria-label="保存图表维度"
            ><ElOption
              v-for="column in evidence.result.columns"
              :key="column.name"
              :value="column.name"
              :label="column.name" /></ElSelect></label
        ><label
          >数值<ElSelect v-model="y" aria-label="保存图表数值"
            ><ElOption
              v-for="column in numeric"
              :key="column.name"
              :value="column.name"
              :label="column.name" /></ElSelect
        ></label>
      </div>
      <p class="muted">保留本次查询条件。保存后可编辑筛选条件，按新的日期和科室重新运行。</p>
      <p v-if="evidence.result.truncated" class="muted">
        此结果已截断，保存的明细是本次已交付的数据。
      </p>
      <p v-if="error" role="alert" class="inline-error">{{ error }}</p>
      <p v-if="uncertain" role="alert">保存回执未确认，请先在报表中心核对，避免重复创建。</p>
      <footer class="report-heading-actions">
        <ElButton :disabled="saving" @click="emit('close')">关闭</ElButton
        ><RouterLink v-if="savedId" :to="`/reports/${encodeURIComponent(savedId)}`"
          >查看已保存报表</RouterLink
        ><RouterLink v-else-if="uncertain" to="/reports">打开报表中心</RouterLink
        ><ElButton
          v-else
          type="primary"
          native-type="submit"
          :loading="saving"
          :disabled="!title.trim() || (kind !== 'table' && (!x || !y))"
          >保存报表</ElButton
        >
      </footer>
    </form>
  </ElDialog>
</template>
