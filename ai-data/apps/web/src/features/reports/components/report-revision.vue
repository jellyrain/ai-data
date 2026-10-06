<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput, ElSelect, ElOption, ElMessageBox } from "element-plus";
import { ArrowUp, Sparkles, X } from "lucide-vue-next";
import { useServices } from "../../../app/services";
import ClarificationForm from "../../analysis/components/clarification-form.vue";
defineProps<{ save: () => Promise<boolean> }>();
const emit = defineEmits<{ close: [] }>();
const { reportEditor: editor, reportRevisions: store } = useServices();
import { projectRunTimeline } from "../../analysis/stores/run-timeline";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
const expanded = ref(true);
const timeline = computed(() => projectRunTimeline(store.state.events));
const prompt = ref(""),
  agent = ref("");
const state = store.state;
watch(
  () => state.committed,
  (value) => {
    expanded.value = !value;
  },
);
const labels: Record<string, string> = {
  created: "等待开始",
  running: "正在修改报表",
  waiting_clarification: "等待补充",
  cancelling: "正在停止",
  completed: "修改运行完成",
  cancelled: "修改已停止",
  failed: "修改失败",
};
const lockedInput = computed(() => store.active || editor.state.saving || editor.state.locked);
async function send(save: () => Promise<boolean>) {
  if (editor.state.locked && !state.uncertain) return;
  if (editor.dirty && !state.uncertain) {
    try {
      await ElMessageBox.confirm(
        "AI 将基于已保存版本修改报表。先保存当前草稿，或放弃草稿后继续。",
        "选择修改基准",
        {
          confirmButtonText: "保存并继续",
          cancelButtonText: "放弃草稿并继续",
          distinguishCancelAndClose: true,
        },
      );
      if (!(await save())) return;
    } catch (action) {
      if (action !== "cancel") return;
      editor.discard();
    }
  }
  if (editor.state.baseline)
    await store.start(editor.state.baseline.version, prompt.value, agent.value || undefined);
}
</script>
<template>
  <section class="report-revision canvas-floating" aria-label="AI 修改报表">
    <header>
      <span
        ><Sparkles :size="16" />AI 修改
        <small class="muted"
          >{{ editor.state.baseline?.definition.title }} · v{{
            editor.state.baseline?.version
          }}</small
        ></span
      ><ElButton text aria-label="收起 AI 修改" @click="emit('close')"><X :size="16" /></ElButton>
    </header>
    <div
      v-if="state.receipt || state.error || state.restoring"
      class="revision-progress"
      role="status"
    >
      <strong>{{
        state.restoring
          ? "正在恢复修改任务"
          : state.committed
            ? `已保存版本 ${state.version + 1}`
            : state.restoreRunId && !state.receipt
              ? "修改任务恢复失败"
              : labels[state.run?.status ?? "created"]
      }}</strong>
      <p v-if="state.progress && store.active">{{ state.progress }}</p>
      <p v-if="state.connection === 'reconnecting'">正在恢复连接…</p>
      <p v-if="state.run?.error" class="inline-error">{{ state.run.error.message }}</p>
      <p v-if="state.error" class="inline-error" role="alert">
        {{ state.error
        }}<ElButton v-if="state.receipt" text @click="store.connect()">重新连接</ElButton>
        <ElButton
          v-else-if="state.restoreRunId"
          text
          :loading="state.restoring"
          @click="store.restore(state.restoreRunId)"
          >重新恢复</ElButton
        >
      </p>
    </div>
    <div class="revision-timeline">
      <ElButton v-if="state.committed && timeline.length" text @click="expanded = !expanded"
        >{{ expanded ? "收起修改过程" : "查看修改过程" }} ·
        {{ timeline.filter((item) => item.kind === "tool").length }} 次工具调用</ElButton
      >
      <template v-for="item in timeline" :key="item.key"
        ><MarkdownContent
          v-if="item.kind === 'message' && (expanded || item.final)"
          :text="item.content"
          :streaming="!item.completed && store.active"
        />
        <details v-else-if="item.kind === 'tool' && expanded">
          <summary>
            {{ item.name }} ·
            {{ item.success === undefined ? "执行中" : item.success ? "已完成" : "失败" }}
          </summary>
          <p>{{ item.input }}</p>
          <p>{{ item.output }}</p>
        </details>
        <p v-else-if="item.kind === 'progress' && expanded" class="muted">
          {{ item.content }}
        </p></template
      >
    </div>
    <ClarificationForm
      v-if="state.run?.clarification && state.run.status === 'waiting_clarification'"
      :question="state.run.clarification"
      :loading="state.answering"
      @answer="store.answer($event)"
    />
    <p v-if="state.uncertain" class="muted">请求结果待确认，重试会复用原修改要求与操作键。</p>
    <form @submit.prevent="send(save)">
      <ElInput
        v-model="prompt"
        type="textarea"
        :rows="3"
        :maxlength="32000"
        aria-label="AI 修改要求"
        placeholder="描述你想调整的字段、条件或展示方式…"
        :disabled="lockedInput"
      />
      <footer>
        <ElSelect
          v-model="agent"
          aria-label="修改使用的 Agent"
          placeholder="默认 Agent"
          :disabled="lockedInput"
          @visible-change="$event && editor.loadAgents()"
          ><ElOption label="默认 Agent" value="" /><ElOption
            v-for="item in editor.state.agents.filter((a) => a.enabled)"
            :key="item.agent_id"
            :value="item.agent_id"
            :label="item.name" /></ElSelect
        ><span class="muted">成功后保存新版本</span
        ><ElButton
          v-if="store.active && state.receipt"
          :loading="state.cancelling"
          @click="store.cancel()"
          >停止</ElButton
        ><ElButton
          v-else
          type="primary"
          native-type="submit"
          :loading="state.sending"
          :disabled="
            !prompt.trim() ||
            !editor.state.baseline ||
            editor.state.saving ||
            (editor.state.locked && !state.uncertain) ||
            !!editor.state.latest ||
            editor.state.uncertain
          "
          :aria-label="state.uncertain ? '重试 AI 修改' : '发送 AI 修改'"
          ><ArrowUp :size="18"
        /></ElButton>
      </footer>
    </form>
  </section>
</template>
