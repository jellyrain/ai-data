<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert, ElButton, ElDrawer, ElInput, ElOption, ElSelect, ElSkeleton } from "element-plus";
import { ArrowUp, History, FileSearch, MessagesSquare } from "lucide-vue-next";
import { useServices } from "../../../app/services";
import ConversationList from "../components/conversation-list.vue";
import EvidencePanel from "../components/evidence-panel.vue";
import RunPanel from "../components/run-panel.vue";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
import ExportPanel from "../../exports/export-panel.vue";
import type { ConversationMessage } from "../api/analysis-types";
const { analysis } = useServices();
const state = analysis.state;
const route = useRoute();
const router = useRouter();
const historyOpen = ref(false);
const evidenceOpen = ref(false);
const selectedRun = ref("");
const selectedTool = ref("");
const evidenceTab = ref("queries");
const agentKey = ref("");
const composing = ref(false);
const messagesCount = ref(20);
const messageArea = ref<HTMLElement>();
const messageContent = ref<HTMLElement>();
let contentObserver: ResizeObserver | undefined;
const pinned = ref(true);
// Markdown 延迟渲染和图表加载也可能改变高度，仅在用户仍停留底部时跟随。
watch(messageContent, (content) => {
  contentObserver?.disconnect();
  if (!content || typeof ResizeObserver === "undefined") return;
  contentObserver = new ResizeObserver(() => {
    if (pinned.value && messageArea.value)
      messageArea.value.scrollTop = messageArea.value.scrollHeight;
  });
  contentObserver.observe(content);
});
const submitting = ref(false);
const evidenceMedia = window.matchMedia("(max-width: 1320px)");
const compactEvidence = ref(evidenceMedia.matches);
const updateEvidenceLayout = () => {
  compactEvidence.value = evidenceMedia.matches;
};
evidenceMedia.addEventListener("change", updateEvidenceLayout);
const agent = computed(() =>
  state.agents.find((value) => JSON.stringify([value.agent_id, value.version]) === agentKey.value),
);
const active = computed(() => analysis.activeRun());
const selectedEvidence = computed(() => state.runs[selectedRun.value]);
// 打开依据后继续跟随新增查询和终态；普通文字增量不触发证据请求。
watch(
  () =>
    selectedEvidence.value?.events
      .filter((event) => event.type === "table" || event.type === "run_completed")
      .at(-1)?.sequence,
  async (revision) => {
    const id = selectedRun.value;
    if (!id || revision === undefined) return;
    await analysis.loadEvidence(id);
    const latest = state.runs[id]?.events
      .filter((event) => event.type === "table" || event.type === "run_completed")
      .at(-1)?.sequence;
    if (selectedRun.value === id && latest !== revision) await analysis.loadEvidence(id);
  },
);
const runIds = computed(() => [
  ...new Set(
    state.detail?.messages
      .slice(-messagesCount.value)
      .flatMap((message) => (message.analysisRunId ? [message.analysisRunId] : [])) ?? [],
  ),
]);
const timeline = computed(() => {
  const messages = state.detail?.messages ?? [];
  const items: { key: string; message?: ConversationMessage; runId?: string; fallback?: string }[] =
    [];
  const seen = new Set<string>();
  for (const message of messages.slice(-messagesCount.value)) {
    if (!message.analysisRunId || (message.role === "user" && !seen.has(message.analysisRunId)))
      items.push({ key: message.id, message });
    if (message.analysisRunId && !seen.has(message.analysisRunId)) {
      seen.add(message.analysisRunId);
      const fallback = messages
        .filter(
          (value) => value.analysisRunId === message.analysisRunId && value.role === "assistant",
        )
        .at(-1)?.content;
      items.push({ key: `run-${message.analysisRunId}`, runId: message.analysisRunId, fallback });
    }
  }
  return items;
});
const canSend = computed(
  () =>
    !!state.draft.trim() &&
    state.draft.length <= 64000 &&
    !state.loading &&
    !state.sending &&
    !state.creating &&
    !submitting.value &&
    !active.value &&
    !state.creationUncertain &&
    (!route.params.id || !!state.detail) &&
    (state.detail ? state.detail.conversation.status === "active" : !!agent.value),
);
watch(
  () => state.agents,
  (agents) => {
    if (!agent.value)
      agentKey.value = agents[0] ? JSON.stringify([agents[0].agent_id, agents[0].version]) : "";
  },
);
watch(
  () => route.params.id,
  async (id) => {
    historyOpen.value = false;
    evidenceOpen.value = false;
    selectedRun.value = "";
    selectedTool.value = "";
    messagesCount.value = 20;
    pinned.value = true;
    await analysis.enter(typeof id === "string" ? id : "");
  },
  { immediate: true },
);
watch(
  [runIds, () => state.loading],
  ([ids, loading]) => {
    if (!loading) for (const id of ids) analysis.watchRun(id);
  },
  { immediate: true },
);
watch(
  () => [timeline.value.length, ...Object.values(state.runs).map((run) => run.cursor)],
  async () => {
    await nextTick();
    if (pinned.value && messageArea.value)
      messageArea.value.scrollTop = messageArea.value.scrollHeight;
  },
);
async function submit() {
  if (!canSend.value) return;
  submitting.value = true;
  try {
    if (!state.detail && agent.value) {
      const id = await analysis.create(agent.value);
      if (!id) return;
      await router.push(`/analysis/${encodeURIComponent(id)}`);
    }
    await analysis.send();
  } finally {
    submitting.value = false;
  }
}
function keydown(input: Event | KeyboardEvent) {
  if (!(input instanceof KeyboardEvent)) return;
  const event = input;
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    composing.value ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  void submit();
}
async function newAnalysis() {
  historyOpen.value = false;
  await router.push("/analysis");
}
async function deleteConversations(ids: string[]) {
  const current = String(route.params.id ?? "");
  if (await analysis.deleteConversations(ids)) {
    if (ids.includes(current)) await router.push("/analysis");
  }
}
function showEvidence(id: string, toolKey = "") {
  selectedRun.value = id;
  selectedTool.value = toolKey;
  evidenceTab.value = toolKey ? "tools" : "queries";
  evidenceOpen.value = true;
  void analysis.loadEvidence(id);
}
function toggleEvidence() {
  if (evidenceOpen.value) {
    evidenceOpen.value = false;
    return;
  }
  if (!selectedRun.value) selectedRun.value = runIds.value.at(-1) ?? "";
  evidenceOpen.value = true;
  if (selectedRun.value) void analysis.loadEvidence(selectedRun.value);
}
function scroll() {
  const area = messageArea.value;
  if (area) pinned.value = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
}
function latest() {
  if (messageArea.value) messageArea.value.scrollTop = messageArea.value.scrollHeight;
  pinned.value = true;
}
onBeforeUnmount(() => {
  contentObserver?.disconnect();
  evidenceMedia.removeEventListener("change", updateEvidenceLayout);
  analysis.leave();
});
</script>
<template>
  <div class="analysis-workbench" :class="{ 'evidence-visible': evidenceOpen && !compactEvidence }">
    <aside class="analysis-conversations">
      <ConversationList
        :items="state.conversations"
        :current="state.detail?.conversation.id"
        :error="state.listError"
        :deleting="state.deleting"
        @delete="deleteConversations"
        @create="newAnalysis"
        @retry="analysis.refreshLists()"
      />
    </aside>
    <div class="analysis-main">
      <header class="analysis-header">
        <div>
          <h1>分析工作台</h1>
          <p v-if="state.detail" class="muted conversation-title">
            {{ state.detail.conversation.title || "新分析" }}
          </p>
        </div>
        <div class="analysis-header-actions">
          <ExportPanel
            :source="
              state.detail ? { kind: 'conversation', id: state.detail.conversation.id } : null
            "
            :disabled="!!active || state.sending || state.loading"
          />
          <ElButton class="history-toggle" aria-label="打开最近会话" @click="historyOpen = true"
            ><History :size="18" /></ElButton
          ><ElButton
            class="evidence-toggle"
            :aria-label="evidenceOpen ? '收起分析依据' : '打开分析依据'"
            :title="evidenceOpen ? '收起分析依据' : '打开分析依据'"
            :aria-expanded="evidenceOpen"
            @click="toggleEvidence"
            ><FileSearch :size="18"
          /></ElButton>
        </div>
      </header>
      <div ref="messageArea" class="analysis-messages" @scroll.passive="scroll">
        <div ref="messageContent" class="analysis-message-content">
          <ElSkeleton v-if="state.loading" :rows="7" animated aria-label="正在读取会话" />
          <template v-else>
            <section v-if="route.params.id && !state.detail" class="analysis-welcome">
              <h2>暂时无法读取这段会话</h2>
              <p>请检查连接和访问权限后重试。</p>
              <ElButton @click="analysis.enter(String(route.params.id), true)"
                >重新读取会话</ElButton
              >
            </section>
            <section v-else-if="!state.detail?.messages.length" class="analysis-welcome">
              <MessagesSquare :size="30" :stroke-width="1.5" />
              <h2>从业务问题，找到数据依据</h2>
              <p>描述你想了解的指标、时间范围或变化，分析助手会逐步查询，并保留结果来源。</p>
              <div class="question-examples">
                <ElButton text @click="analysis.setDraft('分析本年各科室门诊人次的变化趋势')"
                  >分析各科室门诊趋势</ElButton
                ><ElButton text @click="analysis.setDraft('比较本月与上月的业务量，并说明变化原因')"
                  >比较月度业务变化</ElButton
                >
              </div>
            </section>
            <ElButton
              v-if="(state.detail?.messages.length ?? 0) > messagesCount"
              text
              @click="messagesCount += 20"
              >读取更早的消息</ElButton
            >
            <template v-for="item in timeline" :key="item.key">
              <article
                v-if="item.message"
                :class="[
                  'conversation-message',
                  item.message.role === 'user' ? 'user-message' : 'history-message',
                ]"
              >
                <strong>{{ item.message.role === "user" ? "你" : "历史消息" }}</strong>
                <p v-if="item.message.role === 'user'" class="plain-content">
                  {{ item.message.content }}
                </p>
                <MarkdownContent v-else :text="item.message.content" /><small
                  v-if="!item.message.analysisRunId && item.message.role !== 'user'"
                  class="muted"
                  >此历史消息未关联运行详情。</small
                >
              </article>
              <RunPanel
                v-if="item.runId && state.runs[item.runId]"
                :run="state.runs[item.runId]!"
                :fallback="item.fallback"
                :answering="state.answering"
                :cancelling="state.cancelling"
                :selected-tool="selectedRun === item.runId ? selectedTool : ''"
                @cancel="analysis.cancel(item.runId!)"
                @reconnect="analysis.reconnect(item.runId!)"
                @answer="analysis.answer(item.runId!, $event)"
                @evidence="showEvidence(item.runId!)"
                @load-results="analysis.loadEvidence(item.runId!)"
                @tool="showEvidence(item.runId!, $event)"
              />
            </template>
          </template>
        </div>
      </div>
      <div class="analysis-composer">
        <ElButton v-if="!pinned" text class="latest-message" @click="latest">查看最新回复</ElButton>
        <ElAlert
          v-if="state.error"
          :title="state.error"
          type="error"
          :closable="false"
          show-icon
          class="analysis-error"
        />
        <div v-if="state.creationUncertain" class="creation-recovery">
          <p>创建结果尚未确认，请先查看最近会话。确认列表中没有目标会话后，可再次新建。</p>
          <ElButton @click="historyOpen = true">检查最近会话</ElButton
          ><ElButton @click="analysis.confirmCreateRetry()">已检查，允许再次新建</ElButton>
        </div>
        <div class="agent-selection">
          <template v-if="state.detail"
            ><span class="muted">当前 Agent</span
            ><strong
              >{{
                state.boundAgent?.name ||
                state.detail.conversation.agentId ||
                "历史会话，运行时绑定"
              }}<span v-if="state.detail.conversation.agentVersion">
                · v{{ state.detail.conversation.agentVersion }}</span
              ></strong
            ></template
          ><template v-else
            ><label for="analysis-agent">分析 Agent</label
            ><ElSelect
              id="analysis-agent"
              v-model="agentKey"
              aria-label="分析 Agent"
              :disabled="state.loading || state.creating"
              placeholder="选择 Agent"
              ><ElOption
                v-for="value in state.agents"
                :key="JSON.stringify([value.agent_id, value.version])"
                :label="`${value.name} · v${value.version}`"
                :value="JSON.stringify([value.agent_id, value.version])" /></ElSelect
          ></template>
        </div>
        <p v-if="!state.loading && !state.detail && !state.agents.length" class="muted">
          暂无可用 Agent，请联系管理员发布并启用配置。<ElButton
            text
            @click="analysis.refreshLists()"
            >重新读取</ElButton
          >
        </p>
        <form class="question-form" @submit.prevent="submit">
          <ElInput
            :model-value="state.draft"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 6 }"
            aria-label="分析问题"
            placeholder="描述你的问题，例如：本年门诊人次有哪些变化？"
            :maxlength="64000"
            :readonly="state.pendingMessage"
            @update:model-value="analysis.setDraft($event)"
            @keydown="keydown"
            @compositionstart="composing = true"
            @compositionend="composing = false"
          />
          <div class="composer-footer">
            <span class="muted">{{
              active
                ? "本轮结束后可继续提问"
                : state.pendingMessage
                  ? "提交未确认，重试将沿用原问题"
                  : "Enter 发送 · Shift + Enter 换行"
            }}</span
            ><ElButton
              native-type="submit"
              type="primary"
              :disabled="!canSend"
              :loading="state.sending || state.creating"
              :aria-label="state.pendingMessage ? '重试发送' : '发送问题'"
              ><ArrowUp :size="17" />{{ state.pendingMessage ? "重试发送" : "发送" }}</ElButton
            >
          </div>
        </form>
      </div>
    </div>
    <aside v-if="evidenceOpen && !compactEvidence" class="analysis-evidence" aria-label="分析依据">
      <EvidencePanel
        v-model:tab="evidenceTab"
        :run="selectedEvidence"
        :tool-key="selectedTool"
        closable
        @close="evidenceOpen = false"
        @select-tool="selectedTool = $event"
        @retry="analysis.loadEvidence(selectedRun)"
      />
    </aside>
    <ElDrawer v-model="historyOpen" title="最近会话" direction="ltr" size="min(320px, 100vw)"
      ><ConversationList
        :items="state.conversations"
        :current="state.detail?.conversation.id"
        :error="state.listError"
        :deleting="state.deleting"
        @delete="deleteConversations"
        @navigate="historyOpen = false"
        @create="newAnalysis"
        @retry="analysis.refreshLists()"
    /></ElDrawer>
    <ElDrawer
      v-if="compactEvidence"
      v-model="evidenceOpen"
      class="evidence-drawer"
      title="分析依据"
      size="min(420px, 100vw)"
      ><EvidencePanel
        v-model:tab="evidenceTab"
        :run="selectedEvidence"
        :tool-key="selectedTool"
        @select-tool="selectedTool = $event"
        @retry="analysis.loadEvidence(selectedRun)"
    /></ElDrawer>
  </div>
</template>
