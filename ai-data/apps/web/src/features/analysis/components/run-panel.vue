<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton } from "element-plus";
import { Check, ChevronRight, LoaderCircle, Wrench, CircleAlert, Square } from "lucide-vue-next";
import type { RunView } from "../stores/analysis-workspace-types";
import { projectRunTimeline } from "../stores/run-timeline";
import { toolActivityLabel } from "../models/tool-activity";
import type { RunTimelineItem } from "../stores/run-timeline-types";
import { isTerminal } from "../../../shared/stream/run-stream";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
import QueryResults from "./query-results.vue";
import ClarificationForm from "./clarification-form.vue";
const props = defineProps<{
  run: RunView;
  fallback?: string;
  answering: boolean;
  cancelling: boolean;
  selectedTool?: string;
}>();
defineEmits<{
  reconnect: [];
  cancel: [];
  evidence: [];
  loadResults: [];
  tool: [key: string];
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
// 原始结果由查询数据面板统一呈现；完成后保留过程与最终正文的顺序。
const displayedTimeline = computed(() =>
  status.value === "completed"
    ? [
        ...timeline.value.filter(isProcessItem),
        ...timeline.value.filter((item) => item.kind === "message" && item.final),
      ]
    : timeline.value.filter((item) => item.kind !== "table"),
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
        <button
          v-else-if="item.kind === 'tool'"
          v-show="processVisible"
          type="button"
          class="tool-record"
          :class="{ 'tool-failed': item.success === false, selected: selectedTool === item.key }"
          :data-tool-key="item.key"
          :aria-label="`${toolActivityLabel(item, finished)}，查看调用详情`"
          :aria-pressed="selectedTool === item.key"
          @click="$emit('tool', item.key)"
        >
          <LoaderCircle v-if="item.success === undefined && !finished" :size="14" class="spin" />
          <CircleAlert v-else-if="item.success === false" :size="14" />
          <Wrench v-else :size="14" />
          <span>{{ toolActivityLabel(item, finished) }}</span>
        </button>
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
      </template>
    </div>
    <MarkdownContent v-if="legacyAnswer" :text="legacyAnswer" />
    <QueryResults :run="run" @load="$emit('loadResults')" />
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
        >查看分析依据</ElButton
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
.message-output-status {
  display: block;
  font-size: 12px;
  margin-top: 6px;
}
</style>
