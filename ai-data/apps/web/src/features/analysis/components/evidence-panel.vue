<script setup lang="ts">
import { ElButton, ElTabs, ElTabPane, ElSelect, ElOption } from "element-plus";
import { FileSearch, X } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import type { RunView } from "../stores/analysis-workspace-types";
import { projectRunTimeline } from "../stores/run-timeline";
import { relatedToolEvidence, toolAction, toolActivityLabel } from "../models/tool-activity";
import { isTerminal } from "../../../shared/stream/run-stream";
const props = defineProps<{ run?: RunView; toolKey?: string; tab: string; closable?: boolean }>();
const emit = defineEmits<{
  retry: [];
  close: [];
  selectTool: [key: string];
  "update:tab": [tab: string];
}>();
const root = ref<HTMLElement>();
const tools = computed(() =>
  projectRunTimeline(props.run?.events ?? []).filter((item) => item.kind === "tool"),
);
const selectedTool = computed(
  () => tools.value.find((item) => item.key === props.toolKey) ?? tools.value.at(-1),
);
const finished = computed(() => isTerminal(props.run?.snapshot?.status ?? "created"));
const related = computed(() =>
  selectedTool.value ? relatedToolEvidence(selectedTool.value, props.run?.evidence ?? []) : [],
);
async function showQuery(id: string) {
  emit("update:tab", "queries");
  await nextTick();
  const element = [...(root.value?.querySelectorAll<HTMLElement>("[data-evidence-id]") ?? [])].find(
    (item) => item.dataset.evidenceId === id,
  );
  element?.scrollIntoView({ block: "nearest" });
  element?.focus({ preventScroll: true });
}
const copyStatus = ref("");
async function copySql(sql: string) {
  try {
    await navigator.clipboard.writeText(sql);
    copyStatus.value = "SQL 已复制";
  } catch {
    copyStatus.value = "复制失败，请选中 SQL 手动复制";
  }
}
const stepLabels: Record<string, string> = {
  planned: "待验证",
  supported: "已支持",
  rejected: "已否定",
  inconclusive: "尚无定论",
};
</script>
<template>
  <section ref="root" class="evidence-panel">
    <div class="evidence-heading">
      <FileSearch :size="18" />
      <h2>分析依据</h2>
      <ElButton
        v-if="closable"
        text
        class="evidence-close"
        aria-label="关闭分析依据"
        title="关闭分析依据"
        @click="emit('close')"
        ><X :size="16" />
      </ElButton>
    </div>
    <p v-if="!run" class="muted">分析结果产生后，可查看数据来源、筛选条件与验证步骤。</p>
    <ElTabs
      v-if="run"
      :model-value="tab"
      class="evidence-tabs"
      aria-label="依据类型"
      @update:model-value="emit('update:tab', String($event))"
    >
      <ElTabPane name="tools" :label="`工具调用 · ${tools.length}`" />
      <ElTabPane
        name="queries"
        :label="`查询依据 · ${run.evidence.length || run.snapshot?.evidence_ids.length || 0}`"
      />
    </ElTabs>
    <section v-if="run && tab === 'tools'" class="tool-evidence" aria-label="工具调用详情">
      <ElSelect
        v-if="tools.length"
        :model-value="selectedTool?.key"
        aria-label="选择工具调用"
        @update:model-value="emit('selectTool', $event)"
      >
        <ElOption
          v-for="(item, index) in tools"
          :key="item.key"
          :value="item.key"
          :label="`${index + 1}. ${toolActivityLabel(item, finished)}`"
        />
      </ElSelect>
      <article v-if="selectedTool" :key="selectedTool.key" class="tool-evidence-detail">
        <h3>{{ toolAction(selectedTool.name) }}</h3>
        <p class="muted tool-name">
          {{ selectedTool.name }} · 第
          {{ tools.findIndex((item) => item.key === selectedTool?.key) + 1 }} 次调用
        </p>
        <dl class="tool-facts">
          <dt>执行状态</dt>
          <dd :class="{ 'inline-error': selectedTool.success === false }">
            {{
              selectedTool.success === true
                ? "已完成"
                : selectedTool.success === false
                  ? "执行失败"
                  : finished
                    ? "结果未记录"
                    : "执行中"
            }}
          </dd>
          <template v-if="selectedTool.durationMs !== undefined"
            ><dt>耗时</dt>
            <dd>{{ selectedTool.durationMs.toLocaleString() }} ms</dd></template
          >
        </dl>
        <details open>
          <summary>调用参数</summary>
          <pre class="plain-content">{{ selectedTool.input || "这次调用未留存参数摘要。" }}</pre>
        </details>
        <details open>
          <summary>{{ selectedTool.success === false ? "错误详情" : "执行结果" }}</summary>
          <pre class="plain-content" :class="{ 'inline-error': selectedTool.success === false }">{{
            selectedTool.output || (finished ? "这次调用未留存结果摘要。" : "等待工具返回…")
          }}</pre>
        </details>
        <div class="related-queries">
          <h3>关联查询</h3>
          <p v-if="run.evidenceLoading" role="status" class="muted">正在读取查询依据…</p>
          <p v-else-if="run.evidenceError" class="inline-error">
            {{ run.evidenceError }} <ElButton text @click="emit('retry')">重新读取依据</ElButton>
          </p>
          <template v-else-if="related.length">
            <ElButton
              v-for="item in related"
              :key="item.evidence_id"
              text
              @click="showQuery(item.evidence_id)"
              >查询
              {{ run.evidence.findIndex((value) => value.evidence_id === item.evidence_id) + 1 }} ·
              {{ item.result.row_count.toLocaleString() }} 行 · 查看 SQL</ElButton
            >
          </template>
          <p v-else class="muted">这次调用暂无关联的查询证据。</p>
        </div>
      </article>
      <p v-else class="muted">本次运行尚无工具调用记录。</p>
    </section>
    <div v-if="run && tab === 'queries'">
      <p v-if="run.evidenceLoading" role="status" class="muted">正在复核权限并读取依据…</p>
      <template v-else-if="run.evidenceError"
        ><p role="alert" class="inline-error">{{ run.evidenceError }}</p>
        <ElButton @click="$emit('retry')">重新读取依据</ElButton></template
      ><template v-else
        ><p v-if="run.evidenceLoaded && !run.evidence.length" class="muted">
          本次运行没有保存查询证据。
        </p>
        <article
          v-for="(item, index) in run.evidence"
          :key="item.evidence_id"
          class="evidence-item"
          :data-evidence-id="item.evidence_id"
          tabindex="-1"
        >
          <h3>查询 {{ index + 1 }}</h3>
          <dl>
            <dt>数据源</dt>
            <dd>{{ item.authorized_query.source_id }}</dd>
            <dt>对象／数据集</dt>
            <dd>{{ item.authorized_query.from.object_id }}</dd>
            <dt>生成时间 · UTC+8</dt>
            <dd>{{ item.created_at }}</dd>
            <dt>数据新鲜度</dt>
            <dd>{{ item.result.freshness || "未提供" }}</dd>
            <dt>指标版本</dt>
            <dd>
              {{ item.metric ? `${item.metric.metric_id} · v${item.metric.version}` : "未提供" }}
            </dd>
            <dt>结果范围</dt>
            <dd>
              {{ item.result.row_count.toLocaleString() }} 行已交付{{
                item.result.truncated ? "，已截断，总量未知" : "，本次查询完整返回"
              }}
            </dd>
          </dl>
          <details>
            <summary>条件与时间范围</summary>
            <pre class="plain-content">{{ JSON.stringify(item.requested_query, null, 2) }}</pre>
          </details>
          <details>
            <summary>实际执行条件</summary>
            <pre class="plain-content">{{ JSON.stringify(item.authorized_query, null, 2) }}</pre>
          </details>
          <details class="evidence-sql">
            <summary>执行 SQL</summary>
            <template v-if="item.result.execution_sql">
              <p class="muted">{{ item.result.execution_sql.dialect }}</p>
              <ElButton text @click="copySql(item.result.execution_sql.sql)">复制 SQL</ElButton>
              <pre class="plain-content"><code>{{ item.result.execution_sql.sql }}</code></pre>
              <p v-if="item.result.execution_sql.parameters.length" class="muted">
                参数按绑定顺序展示；值由查询条件确定。
              </p>
              <p
                v-for="parameter in item.result.execution_sql.parameters"
                :key="parameter.position"
                class="muted"
              >
                {{ parameter.position }}. {{ parameter.placeholder }} · {{ parameter.data_type }}
              </p>
            </template>
            <p v-else class="muted">这份查询证据未留存执行 SQL。</p>
          </details>
          <small class="muted">证据 {{ item.evidence_id }}</small>
        </article>
        <section v-if="run.steps.length" class="analysis-steps">
          <h3>验证步骤</h3>
          <article v-for="step in run.steps" :key="step.step_id">
            <strong>{{ step.title }}</strong
            ><span class="muted"> · {{ stepLabels[step.status] }}</span>
            <p v-if="step.hypothesis">{{ step.hypothesis }}</p>
            <p v-if="step.conclusion">{{ step.conclusion }}</p>
            <small class="muted">引用 {{ step.evidence_ids.length }} 份证据</small>
          </article>
        </section></template
      >
      <p v-if="copyStatus" role="status" class="muted">{{ copyStatus }}</p>
    </div>
  </section>
</template>
