<script setup lang="ts">
import type { QueryEvidence } from "@ai-data/contracts";
import SaveResultReport from "../../reports/components/save-result-report.vue";
import { computed, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { Check, ChevronRight, LoaderCircle, Wrench, CircleAlert, Square } from "lucide-vue-next";
import type { RunView } from "../stores/analysis-workspace-types";
import { projectRunTimeline } from "../stores/run-timeline";
import type { RunTimelineItem } from "../stores/run-timeline-types";
import { isTerminal } from "../../../shared/stream/run-stream";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
import ResultTable from "../../../shared/results/result-table.vue";
import ClarificationForm from "./clarification-form.vue";
const savingEvidence = ref<QueryEvidence>();
const props = defineProps<{
  run: RunView;
  fallback?: string;
  answering: boolean;
  cancelling: boolean;
}>();
defineEmits<{
  reconnect: [];
  cancel: [];
  evidence: [];
  answer: [value: { option_id?: string; custom_input?: string }];
}>();
const labels: Record<string, string> = {
  created: "等待分析",
  running: "正在分析",
  waiting_clarification: "等待补充",
  cancelling: "正在停止",
  completed: "分析完成",
  failed: "分析失败",
  cancelled: "已停止",
};
const status = computed(() => props.run.snapshot?.status ?? "created");
const finished = computed(() => isTerminal(status.value));
const timeline = computed(() => projectRunTimeline(props.run.events));
const processExpanded = ref(true);
watch(
  status,
  (value) => {
    processExpanded.value = value !== "completed";
  },
  { immediate: true },
);
const processVisible = computed(() => status.value !== "completed" || processExpanded.value);
function isProcessItem(item: RunTimelineItem) {
  return item.kind !== "table" && !(item.kind === "message" && item.final);
}
const hasProcess = computed(() => timeline.value.some(isProcessItem));
const toolCount = computed(() => timeline.value.filter((item) => item.kind === "tool").length);
// 完成后将正文和表格放在过程之后；稳定的条目 key 保留表格和工具展开状态。
const displayedTimeline = computed(() =>
  status.value === "completed"
    ? [
        ...timeline.value.filter(isProcessItem),
        ...timeline.value.filter((item) => item.kind === "message" && item.final),
        ...timeline.value.filter((item) => item.kind === "table"),
      ]
    : timeline.value,
);
function outputActive(item: RunTimelineItem) {
  return (
    item.kind === "message" &&
    !item.completed &&
    status.value === "running" &&
    item.key.startsWith(`${props.run.snapshot?.lease_epoch ?? 0}:`)
  );
}
const streaming = computed(() => timeline.value.some(outputActive));
const legacyAnswer = computed(() =>
  status.value === "completed" &&
  !timeline.value.some((item) => item.kind === "message" && item.final && item.content)
    ? props.fallback
    : "",
);
const compaction = computed(
  () =>
    !finished.value &&
    [...props.run.events].reverse().find((event) => event.type === "context_compaction")?.status ===
      "started",
);
const tables = computed(() => props.run.events.filter((event) => event.type === "table"));
const extraEvidence = computed(() =>
  props.run.evidence.filter(
    (item) => !tables.value.some((table) => table.evidence_id === item.evidence_id),
  ),
);
function evidence(id?: string) {
  return id ? props.run.evidence.find((item) => item.evidence_id === id) : undefined;
}
const hasChart = computed(() => props.run.events.some((event) => event.type === "chart"));
</script>
<template>
  <section class="run-panel" :aria-label="`分析运行 ${run.id}`">
    <div class="run-heading">
      <span class="assistant-symbol">AI</span><strong>分析助手</strong>
      <span class="run-status" role="status">
        <Check v-if="status === 'completed'" :size="14" />
        <CircleAlert v-else-if="status === 'failed'" :size="14" />
        <LoaderCircle
          v-else-if="!finished && status !== 'waiting_clarification'"
          :size="14"
          class="spin"
        />
        {{ streaming ? "正在输出" : labels[status] }}
      </span>
    </div>
    <p v-if="run.connection === 'reconnecting'" role="status" class="muted">连接中断，正在恢复…</p>
    <p v-if="compaction" role="status" class="muted">正在整理对话上下文…</p>
    <ElButton
      v-if="status === 'completed' && hasProcess"
      text
      class="process-toggle"
      :aria-expanded="processExpanded"
      @click="processExpanded = !processExpanded"
    >
      <ChevronRight :size="14" :class="{ expanded: processExpanded }" />
      {{ processExpanded ? "收起分析过程" : "查看分析过程" }}
      <span v-if="toolCount" class="muted">· {{ toolCount }} 次工具调用</span>
    </ElButton>
    <div class="run-timeline" aria-label="分析过程">
      <template v-for="item in displayedTimeline" :key="item.key">
        <div
          v-if="item.kind === 'message' && item.content"
          v-show="processVisible || item.final"
          class="assistant-message"
          :data-message-key="item.key"
          :aria-busy="outputActive(item)"
        >
          <MarkdownContent :text="item.content" :streaming="outputActive(item)" />
          <span v-if="outputActive(item)" class="message-output-status muted">正在输出…</span>
          <span v-else-if="!item.completed" class="message-output-status muted">{{
            status === "cancelled" ? "输出已停止" : "输出未完成"
          }}</span>
        </div>
        <details
          v-else-if="item.kind === 'tool'"
          v-show="processVisible"
          class="tool-record"
          :data-tool-key="item.key"
        >
          <summary>
            <Wrench :size="14" /><span>{{ item.name }}</span>
            <span class="tool-status muted"
              ><LoaderCircle
                v-if="item.success === undefined && !finished"
                :size="12"
                class="spin"
              />{{
                item.success === true
                  ? "已完成"
                  : item.success === false
                    ? "执行失败"
                    : finished
                      ? "结果未记录"
                      : "执行中"
              }}</span
            >
          </summary>
          <pre v-if="item.input" class="plain-content">{{ item.input }}</pre>
          <pre v-if="item.output" class="plain-content">{{ item.output }}</pre>
        </details>
        <p v-else-if="item.kind === 'progress'" v-show="processVisible" class="progress-summary">
          {{ item.content }}
        </p>
        <div
          v-else-if="item.kind === 'clarification' && item.answer"
          v-show="processVisible"
          class="clarification-history"
        >
          <span class="muted">已补充 · {{ item.question }}</span>
          <p>{{ item.answer }}</p>
        </div>
        <ResultTable
          v-else-if="item.kind === 'table'"
          :table="evidence(item.event.evidence_id)?.result ?? item.event"
          :row-count="
            evidence(item.event.evidence_id)?.result.row_count ?? item.event.result_row_count
          "
          :sampled="!evidence(item.event.evidence_id) && item.event.sampled"
          :truncated="
            evidence(item.event.evidence_id)?.result.truncated ?? item.event.result_truncated
          "
          :can-load="!!item.event.evidence_id && !run.evidenceLoaded"
          :loading="run.evidenceLoading"
          @load="$emit('evidence')"
        />
      </template>
    </div>
    <MarkdownContent v-if="legacyAnswer" :text="legacyAnswer" />
    <p v-if="hasChart" class="muted">可在结果中选择图表和字段查看。</p>
    <ResultTable
      v-for="item in extraEvidence"
      :key="item.evidence_id"
      :table="item.result"
      :row-count="item.result.row_count"
      :truncated="item.result.truncated"
    />
    <ClarificationForm
      v-if="run.snapshot?.clarification && status === 'waiting_clarification'"
      :key="run.snapshot.clarification.clarification_id"
      :question="run.snapshot.clarification"
      :loading="answering"
      @answer="$emit('answer', $event)"
    />
    <p v-if="run.snapshot?.error" role="alert" class="inline-error">
      {{ run.snapshot.error.message }}
    </p>
    <p v-if="run.error" role="alert" class="inline-error">
      {{ run.error }} <ElButton text @click="$emit('reconnect')">重新连接</ElButton>
    </p>
    <div v-if="status === 'completed' && run.evidence.length" class="save-results-actions">
      <ElButton
        v-for="(item, index) in run.evidence"
        :key="item.evidence_id"
        @click="savingEvidence = item"
        >保存结果 {{ index + 1 }} 为报表</ElButton
      >
    </div>
    <SaveResultReport
      v-if="savingEvidence"
      :evidence="savingEvidence"
      @close="savingEvidence = undefined"
    />
    <div class="run-actions">
      <ElButton
        v-if="!finished"
        :loading="cancelling || status === 'cancelling'"
        :disabled="status === 'cancelling'"
        @click="$emit('cancel')"
        ><Square :size="12" />停止分析</ElButton
      >
      <ElButton
        v-if="tables.length || run.snapshot?.evidence_ids.length || finished"
        text
        @click="$emit('evidence')"
        >{{
          status === "completed" && !run.evidenceLoaded
            ? "读取结果以保存报表 / 查看依据"
            : "查看分析依据"
        }}</ElButton
      >
    </div>
    <p v-if="status === 'failed' || status === 'cancelled'" class="muted">
      本轮{{
        status === "failed" ? "分析失败" : "已停止"
      }}，上方内容为已产生的过程。可在下方继续提问。
    </p>
  </section>
</template>
<style scoped>
.process-toggle {
  margin-bottom: 12px;
  color: var(--el-text-color-secondary);
}
.process-toggle svg {
  margin-right: 6px;
}
.process-toggle svg.expanded {
  transform: rotate(90deg);
}
.process-toggle .muted {
  margin-left: 6px;
}
.run-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.run-timeline > .progress-summary {
  margin: 0;
}
.tool-record {
  margin: 0;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-fill-color-extra-light);
  padding: 8px 12px;
}
.tool-record summary {
  min-height: 24px;
}
.tool-status {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.message-output-status {
  display: block;
  font-size: 12px;
  margin-top: 6px;
}
</style>
