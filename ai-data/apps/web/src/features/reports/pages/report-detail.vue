<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElButton, ElDrawer, ElOption, ElSelect, ElSkeleton } from "element-plus";
import { ArrowLeft, History, SlidersHorizontal } from "lucide-vue-next";
import { useServices } from "../../../app/services";
import { reportSections } from "../models/results";
import ParameterForm from "../components/parameter-form.vue";
import ReportBlock from "../components/report-block.vue";
import ReportNarrative from "../components/report-narrative.vue";
import ReportTemplateSubmit from "../components/report-template-submit.vue";
import ReportSharing from "../components/report-sharing.vue";
import ExportPanel from "../../exports/export-panel.vue";
import type { ExportSource } from "../../exports/export-types";
import type { ParameterValues } from "../models/parameter-types";
const { reports, reportNarratives, auth } = useServices();
const state = reports.state,
  route = useRoute(),
  router = useRouter();
const narrative = ref(false),
  selectedBlock = ref("");
const history = ref(false),
  parameters = ref(false);
const media = window.matchMedia("(max-width: 900px)");
const compact = ref(media.matches);
const resize = () => {
  compact.value = media.matches;
};
media.addEventListener("change", resize);
const busy = computed(() => state.sending || state.execution?.status === "running");
const exportSource = computed<ExportSource | null>(() =>
  state.displayExecution
    ? { kind: "execution", id: state.displayExecution.execution_id, reportId: state.reportId }
    : state.snapshot
      ? { kind: "snapshot", id: state.reportId, version: state.snapshot.version }
      : null,
);
const title = computed(
  () =>
    state.definition?.definition.title ??
    state.snapshot?.title ??
    state.versions.definitions[0]?.definition.title ??
    "报表详情",
);
const sections = computed(() => {
  try {
    return {
      items: state.snapshot ? reportSections(state.snapshot, state.displayExecution) : [],
      error: "",
    };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "结果无法展示" };
  }
});
const blocks = computed(() => sections.value.items.flatMap((section) => section.blocks));
const currentBlock = computed(
  () =>
    blocks.value.find((block) => block.block_id === selectedBlock.value) ??
    blocks.value.find((block) => block.type !== "text") ??
    blocks.value[0],
);
function stringQuery(name: string) {
  return typeof route.query[name] === "string" ? route.query[name] : undefined;
}
watch(
  () => route.params.id,
  async (id) => {
    history.value = false;
    parameters.value = false;
    reportNarratives.leave();
    await reports.open(
      String(id),
      stringQuery("execution"),
      Number(stringQuery("snapshot")) || undefined,
    );
  },
  { immediate: true },
);
watch(
  () => state.displayExecution?.execution_id,
  async (id) => {
    await reportNarratives.select(id ?? "");
    const run = stringQuery("narrative"),
      conversation = stringQuery("conversation");
    if (
      id &&
      reportNarratives.state.executionId === id &&
      run &&
      conversation &&
      stringQuery("execution") === id
    )
      reportNarratives.restore({ analysis_run_id: run, conversation_id: conversation });
  },
);
watch(
  () => reportNarratives.state.receipt,
  (receipt) => {
    if (receipt && reportNarratives.state.executionId === state.displayExecution?.execution_id)
      void router.replace({
        query: {
          execution: reportNarratives.state.executionId,
          narrative: receipt.analysis_run_id,
          conversation: receipt.conversation_id,
        },
      });
  },
);
// 浏览器前进后退按 URL 复核读取，不补发执行请求。
watch(
  () => [route.query.execution, route.query.snapshot],
  async () => {
    if (state.loading || state.sending) return;
    const id = stringQuery("execution"),
      version = Number(stringQuery("snapshot"));
    if (id && id !== state.execution?.execution_id) await reports.selectExecution(id);
    else if (!id && version && version !== state.snapshot?.version)
      await reports.selectSnapshot(version);
  },
);
async function run(values: ParameterValues) {
  parameters.value = false;
  await reports.execute(values);
  if (state.execution) await router.replace({ query: { execution: state.execution.execution_id } });
}
async function snapshot(version: number) {
  history.value = false;
  reportNarratives.leave();
  await reports.selectSnapshot(version);
  if (state.snapshot)
    await router.replace({
      query: state.execution
        ? { execution: state.execution.execution_id }
        : { snapshot: String(version) },
    });
}
onBeforeUnmount(() => {
  media.removeEventListener("change", resize);
  reports.leave();
  reportNarratives.leave();
});
</script>
<template>
  <section class="report-detail">
    <header class="report-page-heading">
      <div>
        <RouterLink to="/reports" class="back-to-reports"
          ><ArrowLeft :size="15" />报表中心</RouterLink
        >
        <h1>{{ title }}</h1>
        <p v-if="state.definition" class="muted">
          {{ state.definition.definition.description || "选择条件，查看业务数据" }}
        </p>
      </div>
      <div class="report-heading-actions">
        <ReportTemplateSubmit
          v-if="state.definition"
          :definition="state.definition"
          :disabled="state.selecting || state.loading"
        />
        <ElButton v-if="state.displayExecution" @click="narrative = true">AI 分析</ElButton
        ><ExportPanel :source="exportSource" :disabled="state.selecting || state.loading" />
        <ReportSharing
          v-if="
            (state.definition?.user_id ?? state.snapshot?.user_id) === auth.state.context?.userId &&
            state.reportId
          "
          :report-id="state.reportId"
          :title="title"
          :result-query="
            state.displayExecution
              ? `?execution=${encodeURIComponent(state.displayExecution.execution_id)}`
              : state.snapshot
                ? `?snapshot=${state.snapshot.version}`
                : ''
          "
        />
        <ElButton
          v-if="state.definition?.user_id === auth.state.context?.userId"
          @click="$router.push(`/reports/${encodeURIComponent(state.reportId)}/edit`)"
          >编辑报表</ElButton
        >
        <ElButton v-if="compact && state.versions.definitions.length" @click="parameters = true"
          ><SlidersHorizontal :size="16" />运行条件</ElButton
        ><ElButton :disabled="busy" @click="history = true"
          ><History :size="16" />结果历史</ElButton
        >
      </div>
    </header>
    <p v-if="state.historyError" role="alert" class="inline-error">
      {{ state.historyError
      }}<ElButton text @click="reports.open(String(route.params.id), stringQuery('execution'))"
        >重新读取报表</ElButton
      >
    </p>
    <ElSkeleton v-if="state.loading" :rows="8" animated aria-label="正在读取报表详情" />
    <div v-else class="report-workspace report-bi-workspace">
      <aside v-if="!compact" class="report-filter-bar">
        <div class="report-filter-heading">
          <strong>筛选条件</strong>
          <details v-if="state.versions.definitions.length" class="report-definition-settings">
            <summary>定义 v{{ state.definition?.version }} · 切换版本</summary>
            <label for="report-definition-version">执行定义版本</label
            ><ElSelect
              v-if="state.versions.definitions.length"
              id="report-definition-version"
              :model-value="state.definition?.version"
              :disabled="busy"
              aria-label="执行定义版本"
              @update:model-value="reports.selectDefinition(Number($event))"
              ><ElOption
                v-for="item in state.versions.definitions"
                :key="item.version"
                :value="item.version"
                :label="`定义 v${item.version}`"
            /></ElSelect>
          </details>
        </div>
        <p v-if="state.definitionError" role="alert" class="inline-error">
          {{ state.definitionError }}
        </p>
        <ParameterForm
          v-if="state.definition"
          :definition="state.definition"
          :busy="busy"
          :uncertain="state.uncertain"
          compact
          :values="
            state.displayExecution?.definition_version === state.definition.version
              ? state.displayExecution.parameters
              : undefined
          "
          @run="run"
        />
        <p v-else-if="!state.versions.definitions.length" class="muted">
          此报表保留历史结果，尚无可运行的统一定义。
        </p>
      </aside>
      <div class="report-result-area">
        <div
          v-if="
            state.sending ||
            (state.execution && state.execution.status !== 'completed') ||
            state.executionError
          "
          class="report-operation"
          role="status"
        >
          <strong>{{
            state.sending
              ? "正在运行报表…"
              : state.execution?.status === "running"
                ? "报表仍在执行"
                : state.execution?.status === "failed"
                  ? "本次运行失败"
                  : state.uncertain
                    ? "执行结果尚未确认"
                    : state.execution?.status === "completed"
                      ? "运行完成"
                      : "执行请求失败"
          }}</strong>
          <p v-if="state.execution?.status === 'failed'" class="inline-error">
            {{ state.execution.error_code }} · 下方保留上次成功结果。
          </p>
          <p v-if="state.executionError" class="inline-error" role="alert">
            {{ state.executionError }}
          </p>
          <p v-if="state.uncertain" class="muted">
            服务端可能仍在执行。相同条件重试会复用本次请求；也可查看结果历史。
          </p>
          <ElButton
            v-if="state.execution && !state.sending"
            text
            :loading="state.refreshing"
            @click="reports.refreshExecution()"
            >刷新执行状态</ElButton
          >
        </div>
        <p v-if="state.resultError" role="alert" class="inline-error">{{ state.resultError }}</p>
        <ElSkeleton v-if="state.selecting" :rows="6" animated />
        <template v-else-if="state.snapshot">
          <div class="report-result-heading">
            <h2>结果 v{{ state.snapshot.version }}</h2>
            <span v-if="!busy && state.execution?.status === 'completed'" class="muted"
              >运行完成</span
            >
            <p class="muted">
              {{ state.snapshot.created_at
              }}<span v-if="state.snapshot.definition_version">
                · 来自定义 v{{ state.snapshot.definition_version }}</span
              >
            </p>
            <div v-if="state.displayExecution" class="report-current-scope">
              <span v-for="(value, key) in state.displayExecution.parameters" :key="key"
                >{{
                  state.displayExecution.definition.parameters.find(
                    (parameter) => parameter.name === key,
                  )?.label ?? key
                }}：{{
                  Array.isArray(value)
                    ? value.join(" 至 ")
                    : typeof value === "boolean"
                      ? value
                        ? "是"
                        : "否"
                      : value
                }}</span
              >
            </div>
            <details v-if="state.displayExecution" class="report-actual-parameters">
              <summary>本次结果的实际条件</summary>
              <dl v-if="Object.keys(state.displayExecution.parameters).length">
                <template v-for="(value, key) in state.displayExecution.parameters" :key="key"
                  ><dt>
                    {{
                      state.displayExecution.definition.parameters.find(
                        (parameter) => parameter.name === key,
                      )?.label ?? key
                    }}
                  </dt>
                  <dd>{{ Array.isArray(value) ? value.join(" 至 ") : value }}</dd></template
                >
              </dl>
              <p v-else class="muted">固定查询条件</p>
            </details>
          </div>
          <p v-if="sections.error" role="alert" class="inline-error">{{ sections.error }}</p>
          <label v-if="blocks.length > 1" class="report-content-picker"
            >报表内容<ElSelect
              :model-value="currentBlock?.block_id"
              aria-label="报表内容"
              @update:model-value="selectedBlock = String($event)"
              ><ElOption
                v-for="block in blocks"
                :key="block.block_id"
                :label="block.title"
                :value="block.block_id" /></ElSelect
          ></label>
          <ReportBlock
            v-if="currentBlock"
            :key="`${state.snapshot.version}:${currentBlock.block_id}`"
            :block="currentBlock"
          />
        </template>
        <div v-else-if="!state.resultError && !state.historyError" class="report-empty">
          <h2>尚无已保存的结果</h2>
          <p class="muted">选择运行条件并运行报表，结果会保存在历史中。</p>
          <ElButton v-if="compact && state.definition" @click="parameters = true"
            >填写运行条件</ElButton
          >
        </div>
      </div>
    </div>
    <ElDrawer v-model="narrative" title="AI 分析" size="min(480px, 100vw)">
      <ReportNarrative
        v-if="
          state.displayExecution &&
          reportNarratives.state.executionId === state.displayExecution.execution_id
        "
      />
    </ElDrawer>
    <ElDrawer v-model="history" title="已保存结果历史" size="min(440px, 100vw)"
      ><p class="muted">快照保留运行当时的定义和条件。</p>
      <p v-if="!state.versions.snapshots.length">尚无已保存的结果。</p>
      <ElButton :loading="state.loading" @click="reports.refreshHistory()">刷新结果历史</ElButton>
      <p v-if="state.historyError" role="alert" class="inline-error">{{ state.historyError }}</p>
      <div class="report-history-list">
        <button
          v-for="item in [...state.versions.snapshots].sort((a, b) => b.version - a.version)"
          :key="item.version"
          :disabled="busy"
          :aria-current="item.version === state.snapshot?.version ? 'true' : undefined"
          @click="snapshot(item.version)"
        >
          <strong>结果 v{{ item.version }}</strong
          ><span>{{ item.created_at }}</span
          ><small>{{
            item.definition_version ? `定义 v${item.definition_version}` : "历史快照"
          }}</small>
        </button>
      </div></ElDrawer
    >
    <ElDrawer
      :model-value="parameters && compact"
      title="运行条件"
      direction="ltr"
      size="min(360px, 100vw)"
      @close="parameters = false"
      ><ElSelect
        :model-value="state.definition?.version"
        :disabled="busy"
        aria-label="执行定义版本"
        @update:model-value="reports.selectDefinition(Number($event))"
        ><ElOption
          v-for="item in state.versions.definitions"
          :key="item.version"
          :value="item.version"
          :label="`定义 v${item.version}`"
      /></ElSelect>
      <p v-if="state.definitionError" role="alert" class="inline-error">
        {{ state.definitionError }}
      </p>
      <ParameterForm
        v-if="state.definition"
        :definition="state.definition"
        :busy="busy"
        :uncertain="state.uncertain"
        @run="run"
    /></ElDrawer>
  </section>
</template>
