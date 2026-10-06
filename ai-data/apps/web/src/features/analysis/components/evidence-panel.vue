<script setup lang="ts">
import { ElButton } from "element-plus";
import { FileSearch } from "lucide-vue-next";
import type { RunView } from "../stores/analysis-workspace-types";
defineProps<{ run?: RunView }>();
defineEmits<{ retry: [] }>();
const stepLabels: Record<string, string> = {
  planned: "待验证",
  supported: "已支持",
  rejected: "已否定",
  inconclusive: "尚无定论",
};
</script>
<template>
  <section class="evidence-panel">
    <div class="evidence-heading">
      <FileSearch :size="18" />
      <h2>分析依据</h2>
    </div>
    <p v-if="!run" class="muted">分析结果产生后，可查看数据来源、筛选条件与验证步骤。</p>
    <p v-else-if="run.evidenceLoading" role="status" class="muted">正在复核权限并读取依据…</p>
    <template v-else-if="run.evidenceError"
      ><p role="alert" class="inline-error">{{ run.evidenceError }}</p>
      <ElButton @click="$emit('retry')">重新读取依据</ElButton></template
    ><template v-else
      ><p v-if="run.evidenceLoaded && !run.evidence.length" class="muted">
        本次运行没有保存查询证据。
      </p>
      <article v-for="(item, index) in run.evidence" :key="item.evidence_id" class="evidence-item">
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
  </section>
</template>
