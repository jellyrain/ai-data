<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput, ElSelect, ElOption } from "element-plus";
import { Database, Sigma, ArrowRight } from "lucide-vue-next";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import type { Dataset, MetricDefinition, ReportQueryItem } from "@ai-data/contracts";
import type { ReportEditor } from "../stores/report-editor";
import { appendQuery, uniqueId } from "../models/definition-editor";
dayjs.extend(utc);
const props = defineProps<{ editor: ReportEditor }>();
const emit = defineEmits<{ added: [queryId: string] }>();
const source = ref(""),
  search = ref(""),
  kind = ref("dataset"),
  error = ref("");
const datasets = computed(() =>
  (props.editor.state.datasets[source.value] ?? []).filter((d) =>
    `${d.name} ${d.object_id} ${d.source_description ?? ""}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
watch(source, (id) => {
  void props.editor.loadDatasets(id);
});
watch(kind, (value) => {
  if (value === "metric") void props.editor.loadMetrics();
});
function save(query: ReportQueryItem["query"], title: string) {
  if (props.editor.state.locked || props.editor.state.saving || props.editor.state.uncertain)
    return;
  if (props.editor.state.draft.queries.length >= 100) {
    error.value = "每份报表最多 100 个查询";
    return;
  }
  error.value = "";
  const definition = props.editor.state.draft,
    query_id = uniqueId(
      "query",
      definition.queries.map((q) => q.query_id),
    );
  props.editor.update(appendQuery(definition, { query_id, query, bindings: [] }, title));
  emit("added", query_id);
}
function addDataset(dataset: Dataset) {
  if (["table", "view"].includes(dataset.kind))
    save(
      {
        type: "relational_query",
        source_id: dataset.source_id,
        from: { object_id: dataset.object_id, alias: "t" },
        joins: [],
        select: dataset.columns.slice(0, 5).map((c) => ({ field: `t.${c.name}`, as: c.name })),
        filters: { logic: "and", items: [] },
        group_by: [],
        order_by: [],
        limit: 1000,
      },
      dataset.name,
    );
  else
    save(
      {
        type: "parameterized_query",
        source_id: dataset.source_id,
        from: { object_id: dataset.object_id, alias: "t" },
        parameters: dataset.query_parameters
          .filter((p) => p.default_value !== undefined)
          .map((p) => ({ name: p.name, data_type: p.data_type, value: p.default_value })),
        limit: 1000,
      },
      dataset.name,
    );
}
function addMetric(metric: MetricDefinition) {
  const date = dayjs().utcOffset(8),
    format = metric.date_basis.data_type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm:ss";
  save(
    {
      type: "metric_query",
      metric_id: metric.metric_id,
      version: metric.version,
      output: "grouped",
      start: date.startOf("month").format(format),
      end: date.endOf("day").format(format),
      dimensions: metric.dimensions.slice(0, 1),
    },
    metric.name,
  );
}
</script>
<template>
  <section class="dataset-picker">
    <div class="editor-tabs">
      <ElButton :type="kind === 'dataset' ? 'primary' : 'default'" @click="kind = 'dataset'"
        >数据对象</ElButton
      ><ElButton :type="kind === 'metric' ? 'primary' : 'default'" @click="kind = 'metric'"
        >业务指标</ElButton
      >
    </div>
    <p v-if="error || editor.state.catalogError" role="alert" class="inline-error">
      {{ error || editor.state.catalogError }}
    </p>
    <template v-if="kind === 'dataset'"
      ><label
        >数据源<ElSelect
          v-model="source"
          aria-label="选择数据源"
          placeholder="选择可用数据源"
          filterable
          @visible-change="$event && !editor.state.sources.length && editor.loadSources()"
          ><ElOption
            v-for="item in editor.state.sources"
            :key="item.source_id"
            :value="item.source_id"
            :label="item.source_id" /></ElSelect
      ></label>
      <div class="editor-row">
        <ElButton text :loading="editor.state.loadingSources" @click="editor.loadSources()"
          >刷新数据源</ElButton
        ><ElButton v-if="editor.state.sourceCursor" text @click="editor.loadSources(true)"
          >加载更多</ElButton
        ><ElButton v-if="source" text @click="editor.loadDatasets(source, true)">刷新对象</ElButton>
      </div>
      <ElInput
        v-model="search"
        aria-label="筛选数据对象"
        placeholder="查找表名、业务说明"
        clearable
      />
      <div class="dataset-options">
        <button
          v-for="dataset in datasets"
          :key="dataset.object_id"
          type="button"
          class="dataset-option"
          @click="addDataset(dataset)"
        >
          <Database :size="18" /><span
            ><strong>{{ dataset.name }}</strong
            ><small>{{ dataset.object_id }} · {{ dataset.columns.length }} 个字段</small
            ><small v-if="dataset.source_description">{{ dataset.source_description }}</small></span
          ><ArrowRight :size="16" />
        </button>
        <p v-if="source && !datasets.length" class="muted">当前没有匹配的可见对象。</p>
      </div></template
    >
    <div v-else class="dataset-options">
      <ElButton text @click="editor.loadMetrics()">刷新指标</ElButton
      ><button
        v-for="metric in editor.state.metrics"
        :key="`${metric.metric_id}:${metric.version}`"
        type="button"
        class="dataset-option"
        @click="addMetric(metric)"
      >
        <Sigma :size="18" /><span
          ><strong>{{ metric.name }}</strong
          ><small>v{{ metric.version }} · {{ metric.grain }}</small></span
        ><ArrowRight :size="16" />
      </button>
      <p v-if="!editor.state.metrics.length" class="muted">当前没有可用的已发布指标。</p>
    </div>
  </section>
</template>
