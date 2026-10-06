<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput } from "element-plus";
import { useServices } from "../../../app/services";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
import ClarificationForm from "../../analysis/components/clarification-form.vue";
import { isTerminal } from "../../../shared/stream/run-stream";
const { reportNarratives: store } = useServices();
const state = store.state;
const prompt = ref("请分析本次结果的主要变化与值得关注的业务现象，并引用结果依据。");
const active = computed(() => !!state.receipt && (!state.run || !isTerminal(state.run.status)));
const labels: Record<string, string> = {
  created: "等待分析",
  running: "正在生成说明",
  waiting_clarification: "等待补充",
  cancelling: "正在停止",
  completed: "说明任务完成",
  failed: "说明生成失败",
  cancelled: "已停止说明生成",
};
watch(
  () => state.executionId,
  () => {
    prompt.value = "请分析本次结果的主要变化与值得关注的业务现象，并引用结果依据。";
  },
);
</script>
<template>
  <section class="report-narrative" aria-label="AI 分析说明">
    <div class="report-block-heading">
      <h2>AI 分析说明</h2>
      <ElButton text :loading="state.loading" @click="store.load()">刷新说明</ElButton>
    </div>
    <p class="muted source-id">说明绑定当前执行 {{ state.executionId }}。</p>
    <article v-for="item in state.items" :key="item.analysis_run_id" class="saved-narrative">
      <MarkdownContent :text="item.content" /><small class="muted"
        >{{ item.created_at }} · 查询 {{ item.query_ids.join("、") }}</small
      >
    </article>
    <p v-if="!state.items.length && !state.loading" class="muted">这次结果还没有保存的分析说明。</p>
    <div v-if="state.receipt" class="narrative-status" role="status">
      <strong>{{ labels[state.run?.status ?? "created"] }}</strong>
      <p v-if="state.progress && active">{{ state.progress }}</p>
      <p v-if="state.connection === 'reconnecting'">连接中断，正在恢复…</p>
      <p v-if="state.run?.error" class="inline-error">{{ state.run.error.message }}</p>
    </div>
    <ClarificationForm
      v-if="state.run?.clarification && state.run.status === 'waiting_clarification'"
      :question="state.run.clarification"
      :loading="state.answering"
      @answer="store.answer($event)"
    />
    <p v-if="state.error" role="alert" class="inline-error">
      {{ state.error
      }}<ElButton v-if="state.receipt" text @click="store.connect()">重新连接说明</ElButton>
    </p>
    <p v-if="state.uncertain" class="muted">
      生成请求尚未确认。相同要求重试会恢复同一任务；刷新页面后可先读取已保存说明。
    </p>
    <form @submit.prevent="store.start(prompt)">
      <ElInput
        v-model="prompt"
        type="textarea"
        :rows="3"
        :maxlength="32000"
        aria-label="分析说明要求"
        :disabled="active || state.sending"
      />
      <div class="narrative-actions">
        <ElButton v-if="active" :loading="state.cancelling" @click="store.cancel()"
          >停止说明生成</ElButton
        ><ElButton
          type="primary"
          native-type="submit"
          :disabled="active || !prompt.trim()"
          :loading="state.sending"
          >{{ state.uncertain ? "重试生成说明" : "生成分析说明" }}</ElButton
        >
      </div>
    </form>
  </section>
</template>
