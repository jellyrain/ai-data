<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { ElButton, ElTabPane, ElTabs } from "element-plus";
import { ChevronRight, Database, FilePlus2 } from "lucide-vue-next";
import type { QueryEvidence } from "@ai-data/contracts";
import type { RunView } from "../stores/analysis-workspace-types";
import { projectQueryResults } from "../models/query-results";
import ResultTable from "../../../shared/results/result-table.vue";
import ExportPanel from "../../exports/export-panel.vue";
import SaveResultReport from "../../reports/components/save-result-report.vue";

const props = defineProps<{ run: RunView }>();
const emit = defineEmits<{ load: [] }>();
const expanded = ref(false);
const selected = ref("");
const saving = ref<QueryEvidence>();
const panelId = useId();
const results = computed(() => projectQueryResults(props.run.events, props.run.evidence));
const count = computed(() =>
  Math.max(results.value.length, props.run.snapshot?.evidence_ids.length ?? 0),
);
const active = computed(
  () => results.value.find((item) => item.key === selected.value) ?? results.value[0],
);
function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) emit("load");
}
watch(
  () => [count.value, props.run.snapshot?.status],
  () => {
    if (expanded.value) emit("load");
  },
);
</script>
<template>
  <section v-if="count" class="query-results" aria-label="查询数据">
    <button
      type="button"
      class="query-results-toggle"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      @click="toggle"
    >
      <Database :size="17" />
      <span>查看查询数据 · {{ count }} 份</span>
      <ChevronRight :size="16" :class="{ expanded }" />
    </button>
    <div v-if="expanded" :id="panelId" class="query-results-body">
      <p v-if="run.evidenceLoading" class="result-notice" role="status">正在读取已保存结果…</p>
      <p v-if="run.evidenceError" class="result-notice inline-error" role="alert">
        {{ run.evidenceError }} <ElButton text @click="emit('load')">重新读取结果</ElButton>
      </p>
      <ElTabs
        v-if="results.length > 1"
        :model-value="active?.key"
        class="query-result-tabs"
        aria-label="查询结果选择"
        @update:model-value="selected = String($event)"
      >
        <ElTabPane
          v-for="item in results"
          :key="item.key"
          :name="item.key"
          :label="`${item.title} · ${(item.rowCount ?? item.table.rows.length).toLocaleString()} 行${item.sampled ? ' · 预览' : ''}`"
        />
      </ElTabs>
      <ResultTable
        v-if="active"
        :key="active.key"
        :title="active.title"
        :table="active.table"
        :row-count="active.rowCount"
        :sampled="active.sampled"
        :truncated="active.truncated"
        :can-load="!!active.evidenceId && !run.evidenceLoaded"
        :loading="run.evidenceLoading"
        @load="emit('load')"
      >
        <template v-if="active.evidenceId && run.snapshot" #actions>
          <ExportPanel
            :source="{
              kind: 'conversation',
              id: run.snapshot.conversation_id,
              evidenceId: active.evidenceId,
            }"
            :disabled="run.snapshot.status !== 'completed'"
            label="导出本表"
          />
          <ElButton
            :disabled="run.snapshot.status !== 'completed' || !active.evidence"
            @click="saving = active.evidence"
            ><FilePlus2 :size="14" />保存为报表</ElButton
          >
        </template>
      </ResultTable>
    </div>
    <SaveResultReport v-if="saving" :evidence="saving" @close="saving = undefined" />
  </section>
</template>
