<script setup lang="ts">
import { computed, ref } from "vue";
import { ElInput, ElSelect, ElOption, ElButton } from "element-plus";
import type { ReportDefinition } from "@ai-data/contracts";
import { createUuid } from "../../../shared/identity/create-uuid";
import type { ReportEditor } from "../stores/report-editor";
import { cloneDefinition } from "../models/definition-editor";
import ReportPreview from "./report-preview.vue";
const props = defineProps<{ editor: ReportEditor }>();
const definition = computed(() => props.editor.state.draft);
const selected = ref("");
const blocks = computed(() =>
  definition.value.presentation
    .flatMap((section) => section.blocks)
    .filter((block) => block.type !== "text"),
);
const current = computed(
  () => blocks.value.find((block) => block.block_id === selected.value) ?? blocks.value[0],
);
function edit(operation: (draft: ReportDefinition) => void) {
  const draft = cloneDefinition(definition.value);
  operation(draft);
  props.editor.update(draft);
}
function fields(queryId: string): string[] {
  const query = definition.value.queries.find((q) => q.query_id === queryId)?.query;
  if (!query) return [];
  if (query.type === "relational_query")
    return query.select.map((c) => c.as ?? c.field.replaceAll(".", "_"));
  if (query.type === "parameterized_query")
    return (
      props.editor.state.datasets[query.source_id]
        ?.find((d) => d.object_id === query.from.object_id)
        ?.columns.map((c) => c.name) ?? []
    );
  const metric = props.editor.state.metrics.find(
    (m) => m.metric_id === query.metric_id && (!query.version || m.version === query.version),
  );
  return [
    ...(query.output === "grouped" ? query.dimensions.map((_, i) => `dimension_${i}`) : []),
    ...(metric?.query.select.map((c) => c.as ?? c.field.replaceAll(".", "_")) ?? []),
  ];
}

function change(values: Partial<NonNullable<typeof current.value>>) {
  edit((draft) => {
    const block = draft.presentation
      .flatMap((section) => section.blocks)
      .find((block) => block.block_id === current.value?.block_id);
    if (block) Object.assign(block, values);
  });
}
function create() {
  const id = definition.value.queries[0]?.query_id;
  if (!id) return;
  edit((draft) => {
    draft.presentation.push({
      section_id: createUuid(),
      title: draft.title,
      blocks: [{ block_id: createUuid(), title: draft.title, type: "table", query_ids: [id] }],
    });
  });
}
function display(kind: "table" | "line" | "bar" | "pie") {
  if (!current.value) return;
  const columns = fields(current.value.query_ids[0] ?? "");
  change(
    kind === "table"
      ? { type: "table", chart: undefined }
      : {
          type: "chart",
          chart: {
            type: kind,
            x: current.value.chart?.x ?? columns[0] ?? "",
            y: current.value.chart?.y ?? columns[1] ?? columns[0] ?? "",
          },
        },
  );
}
</script>
<template>
  <section class="single-presentation">
    <div class="presentation-settings">
      <h2>数据与展示</h2>
      <p class="muted">配置这份报表的展示方式。</p>
      <label
        >简短说明<ElInput
          :model-value="definition.description ?? ''"
          aria-label="报表说明"
          type="textarea"
          :maxlength="1000"
          @update:model-value="
            edit((draft) => {
              draft.description = String($event);
            })
          "
      /></label>
      <label v-if="blocks.length > 1"
        >编辑内容<ElSelect
          :model-value="current?.block_id"
          aria-label="编辑报表内容"
          @update:model-value="selected = String($event)"
          ><ElOption
            v-for="block in blocks"
            :key="block.block_id"
            :value="block.block_id"
            :label="block.title" /></ElSelect
      ></label>
      <template v-if="current">
        <label
          >来源查询<ElSelect
            :model-value="current.query_ids[0]"
            aria-label="展示来源查询"
            @update:model-value="change({ query_ids: [String($event)] })"
            ><ElOption
              v-for="query in definition.queries"
              :key="query.query_id"
              :value="query.query_id"
              :label="query.query_id" /></ElSelect
        ></label>
        <label
          >展示方式<ElSelect
            :model-value="current.type === 'chart' ? current.chart?.type : 'table'"
            aria-label="图表类型"
            @update:model-value="display"
            ><ElOption label="明细表" value="table" /><ElOption
              label="折线图"
              value="line" /><ElOption label="柱状图" value="bar" /><ElOption
              label="饼图"
              value="pie" /></ElSelect
        ></label>
        <label
          >显示标题<ElInput
            :model-value="current.title"
            aria-label="显示标题"
            :maxlength="512"
            @update:model-value="change({ title: String($event) })"
        /></label>
        <template v-if="current.type === 'chart' && current.chart"
          ><label v-for="axis in ['x', 'y'] as const" :key="axis"
            >{{ axis === "x" ? "维度字段" : "数值字段"
            }}<ElSelect
              :model-value="current.chart[axis]"
              :aria-label="`图表${axis}字段`"
              filterable
              @update:model-value="
                change({ chart: { ...current!.chart!, [axis]: String($event) } })
              "
              ><ElOption
                v-for="field in fields(current.query_ids[0]!)"
                :key="field"
                :value="field"
                :label="field" /></ElSelect></label
        ></template>
        <label v-else
          >显示列<ElSelect
            :model-value="current.columns ?? []"
            aria-label="表格显示列"
            multiple
            filterable
            placeholder="全部字段"
            @update:model-value="change({ columns: $event.length ? $event : undefined })"
            ><ElOption
              v-for="field in fields(current.query_ids[0]!)"
              :key="field"
              :value="field"
              :label="field" /></ElSelect
        ></label>
      </template>
      <template v-else
        ><p class="muted">先选择数据，再设置一份图表或明细表。</p>
        <ElButton :disabled="!definition.queries.length" @click="create"
          >设置报表展示</ElButton
        ></template
      >
    </div>
    <ReportPreview
      :report-id="editor.state.reportId"
      :definition="
        current
          ? {
              ...definition,
              presentation: [{ section_id: 'preview', title: definition.title, blocks: [current] }],
            }
          : definition
      "
    />
  </section>
</template>
