<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElButton, ElOption, ElSelect, ElSkeleton } from "element-plus";
import type { MemoryEventSummary } from "@ai-data/contracts";
import { TaskApi } from "../api/task-api";
import { useManagementPage } from "../../../shared/management/use-management-page";
import ManagementFeedback from "../../../shared/management/management-feedback.vue";
import { ApiError } from "../../../shared/http/api-error";
const items = ref<MemoryEventSummary[]>([]),
  limit = ref(50),
  filter = ref("");
const router = useRouter();
async function source(item: MemoryEventSummary) {
  await scope.run(async (request) => {
    const id = await new TaskApi(request).source(item.analysis_run_id);
    await router.push("/analysis/" + encodeURIComponent(id));
  });
}
const labels = { pending: "等待处理", processing: "处理中", done: "已完成", failed: "失败" };
let timer: ReturnType<typeof setTimeout> | undefined,
  active = true;
const { scope } = useManagementPage(
  () => {
    items.value = [];
    clearTimeout(timer);
  },
  () => false,
);
const visible = computed(() =>
  items.value.filter((item) => !filter.value || item.status === filter.value),
);
function schedule() {
  clearTimeout(timer);
  if (
    active &&
    !document.hidden &&
    items.value.some((item) => ["pending", "processing"].includes(item.status))
  )
    timer = setTimeout(() => {
      void load();
    }, 5000);
}
async function load() {
  await scope.run(async (request) => {
    items.value = await new TaskApi(request).list(limit.value);
  });
  schedule();
}
async function retry(item: MemoryEventSummary) {
  await scope.run(async (request) => {
    const api = new TaskApi(request);
    try {
      await api.retry(item.event_id, item.status);
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      items.value = await api.list(limit.value);
      if (items.value.find((value) => value.event_id === item.event_id)?.status === "failed")
        throw error;
      scope.state.notice = "已刷新任务状态，请查看当前处理结果。";
      return;
    }
    items.value = await api.list(limit.value);
    scope.state.notice = "已提交重试，后台将重新处理。";
  });
  schedule();
}
function visibility() {
  clearTimeout(timer);
  if (!document.hidden) void load();
}
onMounted(() => {
  void load();
  document.addEventListener("visibilitychange", visibility);
});
onBeforeUnmount(() => {
  active = false;
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", visibility);
});
</script>
<template>
  <section class="management-page">
    <header class="management-heading">
      <div>
        <h1>后台任务</h1>
        <p class="muted">查看分析完成后的记忆整理进度，重试失败任务。</p>
      </div>
      <ElButton :loading="scope.state.busy" @click="load">刷新任务</ElButton>
    </header>
    <ManagementFeedback v-bind="scope.state" />
    <div class="management-browse-toolbar">
      <ElSelect v-model="filter" aria-label="任务状态" placeholder="全部状态"
        ><ElOption label="全部状态" value="" /><ElOption
          v-for="(label, value) in labels"
          :key="value"
          :label="label"
          :value="value" /></ElSelect
      ><ElSelect
        v-model="limit"
        aria-label="任务返回数量"
        :disabled="scope.state.busy"
        @change="load"
        ><ElOption
          v-for="count in [50, 100, 200]"
          :key="count"
          :label="'最近 ' + count + ' 条'"
          :value="count" /></ElSelect
      ><span class="muted">本次返回 {{ items.length }} 条 · 处理中每 5 秒刷新</span>
    </div>
    <ElSkeleton v-if="scope.state.busy && !items.length" :rows="5" />
    <div v-else class="knowledge-task-list">
      <table>
        <caption class="sr-only">
          记忆整理任务
        </caption>
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>尝试次数</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in visible" :key="item.event_id">
            <td>
              <strong>{{ item.event_id }}</strong
              ><small>分析运行 {{ item.analysis_run_id }}</small
              ><small>创建于 {{ item.created_at }}</small
              ><small v-if="item.last_error_code" class="inline-error"
                >错误码：{{ item.last_error_code }}</small
              >
            </td>
            <td>
              <span
                class="management-badge"
                :class="{
                  'is-active': item.status === 'done',
                  'is-pending': item.status === 'pending' || item.status === 'processing',
                  'is-failed': item.status === 'failed',
                }"
                >{{ labels[item.status] }}</span
              >
            </td>
            <td>{{ item.attempts }}</td>
            <td>{{ item.updated_at }}</td>
            <td>
              <ElButton
                v-if="item.status === 'failed'"
                :disabled="scope.state.busy"
                @click="retry(item)"
                >重试</ElButton
              ><ElButton text :disabled="scope.state.busy" @click="source(item)">来源会话</ElButton>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!visible.length" class="report-empty">
        当前没有匹配的任务。完成分析后产生的记忆整理任务会显示在这里。
      </p>
    </div>
  </section>
</template>
