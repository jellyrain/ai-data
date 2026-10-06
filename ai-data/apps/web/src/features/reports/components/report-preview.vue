<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { ElButton } from "element-plus";
import type { ReportDefinition } from "@ai-data/contracts";
import { useServices } from "../../../app/services";
import { reportSections } from "../models/results";
import ReportBlock from "./report-block.vue";
const props = defineProps<{ reportId: string; definition?: ReportDefinition }>();
const { reports } = useServices();
watch(
  () => props.reportId,
  (id) => {
    if (id) void reports.open(id);
  },
  { immediate: true },
);
onBeforeUnmount(() => reports.leave());
const preview = computed(() => {
  try {
    const { snapshot, displayExecution } = reports.state;
    const execution =
      displayExecution && props.definition
        ? {
            ...displayExecution,
            definition: {
              ...displayExecution.definition,
              presentation: props.definition.presentation,
            },
          }
        : displayExecution;
    return {
      block: snapshot
        ? reportSections(snapshot, execution)
            .flatMap((section) => section.blocks)
            .find((block) => block.type !== "text")
        : undefined,
      error: "",
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "预览无法展示", block: undefined };
  }
});
</script>
<template>
  <section class="report-editor-preview">
    <header>
      <h2>报表预览</h2>
      <ElButton
        v-if="reportId"
        text
        :loading="reports.state.loading"
        @click="reports.open(reportId)"
        >刷新已保存结果</ElButton
      >
    </header>
    <p class="muted">
      {{
        reports.state.snapshot
          ? `使用上次保存结果 · 结果 v${reports.state.snapshot.version}`
          : "保存并运行报表后，可在这里查看结果。"
      }}
    </p>
    <p
      v-if="reports.state.resultError || reports.state.historyError || preview.error"
      role="alert"
      class="inline-error"
    >
      {{ reports.state.resultError || reports.state.historyError || preview.error }}
    </p>
    <ReportBlock v-if="preview.block" :block="preview.block" />
    <div v-else class="report-empty">
      <h3>等待查询结果</h3>
      <p class="muted">数据和筛选改动会在下次运行时生效。</p>
    </div>
  </section>
</template>
