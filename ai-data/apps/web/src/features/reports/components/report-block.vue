<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import { ElButton } from "element-plus";
import MarkdownContent from "../../../shared/content/markdown-content.vue";
import ResultTable from "../../../shared/results/result-table.vue";
import type { ReportBlockView } from "../models/result-types";
const ResultChart = defineAsyncComponent(() => import("../../../shared/results/result-chart.vue"));
const props = defineProps<{ block: ReportBlockView }>();
const asTable = ref(false);
const tables = computed(() =>
  props.block.evidence.map((source) => ({
    source,
    result: {
      ...source.result,
      columns: props.block.columns
        ? props.block.columns.flatMap((name) =>
            source.result.columns.filter((column) => column.name === name),
          )
        : source.result.columns,
    },
  })),
);
</script>
<template>
  <article class="report-block">
    <div class="report-block-heading">
      <h3>{{ block.title }}</h3>
      <ElButton v-if="block.type === 'chart'" text @click="asTable = !asTable">{{
        asTable ? "查看图表" : "查看表格"
      }}</ElButton>
    </div>
    <p v-if="block.error" role="alert" class="inline-error">{{ block.error }}</p>
    <template v-else>
      <template v-if="block.type === 'text'"
        ><MarkdownContent :text="block.content ?? ''" />
        <p v-if="block.sourceExecutionId" class="muted source-id">
          说明来源执行：{{ block.sourceExecutionId }}
        </p></template
      >
      <template v-for="table in tables" v-else :key="table.source.evidence_id">
        <ResultChart
          v-if="block.type === 'chart' && block.chart && !asTable"
          :table="table.source.result"
          :kind="block.chart.type"
          :dimension="block.chart.x"
          :metric="block.chart.y"
        />
        <ResultTable
          v-else
          :table="table.result"
          :row-count="table.source.result.row_count"
          :truncated="table.source.result.truncated"
        />
        <p v-if="block.type === 'chart' && !asTable" class="muted">
          已交付 {{ table.source.result.row_count.toLocaleString() }} 行{{
            table.source.result.truncated ? " · 结果已截断，业务总量未知" : ""
          }}
        </p>
      </template>
    </template>
    <details class="report-evidence">
      <summary>数据依据 · {{ block.evidence.length }} 个来源</summary>
      <div v-for="source in block.evidence" :key="source.evidence_id">
        <p>{{ source.requested_query.source_id }} · {{ source.created_at }}</p>
        <p v-if="source.metric" class="muted">
          指标 {{ source.metric.metric_id }} · v{{ source.metric.version }}
        </p>
        <p class="source-id muted">证据 {{ source.evidence_id }}</p>
        <dl class="report-provenance-summary">
          <dt>数据对象</dt>
          <dd>{{ source.requested_query.from.object_id }}</dd>
          <dt>结果字段</dt>
          <dd>{{ source.result.columns.map((column) => column.name).join("、") }}</dd>
          <dt>数据范围</dt>
          <dd>
            {{ source.result.row_count.toLocaleString() }} 行 ·
            {{ source.result.truncated ? "已截断" : "本次已交付完整结果" }}
          </dd>
          <dt>处理策略</dt>
          <dd>
            {{
              source.output_masks.length
                ? `${source.output_masks.length} 个字段应用脱敏策略`
                : "当前授权范围"
            }}
          </dd>
        </dl>
        <details>
          <summary>查看查询技术详情</summary>
          <pre>{{
            JSON.stringify({ query: source.authorized_query, masks: source.output_masks }, null, 2)
          }}</pre>
        </details>
      </div>
    </details>
  </article>
</template>
