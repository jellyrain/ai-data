<script setup lang="ts">
import { computed, defineAsyncComponent, h, ref, watch } from "vue";
import {
  ElAutoResizer,
  ElButton,
  ElDrawer,
  ElOption,
  ElPagination,
  ElSelect,
  ElTableV2,
  ElPopover,
  ElCheckboxGroup,
  ElCheckbox,
} from "element-plus";
import type { QueryResult } from "@ai-data/contracts";
import { pageRows, formatCell } from "./result-model";
const ResultChart = defineAsyncComponent({
  loader: () => import("./result-chart.vue"),
  delay: 200,
  timeout: 20000,
  loadingComponent: () => h("p", { role: "status", class: "result-notice" }, "正在准备图表…"),
  errorComponent: () =>
    h(
      "p",
      { role: "alert", class: "result-notice" },
      "图表暂时无法加载，请切回表格查看结果，或刷新后重试",
    ),
});
const props = defineProps<{
  title?: string;
  table: Pick<QueryResult, "columns" | "rows">;
  rowCount?: number;
  sampled?: boolean;
  truncated?: boolean;
  canLoad?: boolean;
  loading?: boolean;
}>();
defineEmits<{ load: [] }>();
const visibleColumns = ref<string[]>([]);
const page = ref(1);
const size = ref(100);
const kind = ref<"table" | "bar" | "line" | "pie">("table");
const dimension = ref("");
const metric = ref("");
const cell = ref<string | null>(null);
const paged = computed(() => pageRows(props.table.rows, page.value, size.value));
const rows = computed(() =>
  paged.value.rows.map((row, index) => ({
    row,
    position: (paged.value.page - 1) * size.value + index,
  })),
);
const columns = computed(() =>
  props.table.columns
    .filter((column) => visibleColumns.value.includes(column.name))
    .map((column) => ({
      key: column.name,
      dataKey: column.name,
      title: column.name,
      width: 190,
      flexGrow: 1,
      align: ["integer", "decimal"].includes(column.data_type)
        ? ("right" as const)
        : ("left" as const),
      cellRenderer: ({ rowData }: { rowData: { row: Record<string, unknown> } }) => {
        const value = formatCell(rowData.row[column.name]);
        return value.length > 80
          ? h(
              "button",
              {
                class: "cell-expand",
                title: "展开单元格",
                "aria-label": `展开${column.name}单元格`,
                onClick: () => {
                  cell.value = value;
                },
              },
              `${value.slice(0, 80)}…`,
            )
          : h(
              "span",
              { class: rowData.row[column.name] === null ? "null-value" : undefined, title: value },
              value,
            );
      },
    })),
);
const numericColumns = computed(() =>
  props.table.columns.filter((column) => ["integer", "decimal"].includes(column.data_type)),
);
function fittedColumns(width: number) {
  const columnWidth = Math.max(190, Math.floor(width / Math.max(1, columns.value.length)));
  return columns.value.map((column) => ({ ...column, width: columnWidth }));
}
watch(
  () => props.table.columns,
  (items) => {
    visibleColumns.value = items.map((item) => item.name);
    if (!items.some((item) => item.name === dimension.value))
      dimension.value =
        items.find((item) => !["integer", "decimal"].includes(item.data_type))?.name ??
        items[0]?.name ??
        "";
    if (!numericColumns.value.some((item) => item.name === metric.value))
      metric.value = numericColumns.value[0]?.name ?? "";
  },
  { immediate: true },
);
watch(paged, (value) => {
  page.value = value.page;
});
</script>
<template>
  <section class="result-view" aria-label="查询结果">
    <div class="result-toolbar">
      <div class="result-heading">
        <strong v-if="title">{{ title }}</strong
        ><span class="result-count"
          >已显示 {{ table.rows.length.toLocaleString() }} 行<span v-if="sampled"
            >样本<span v-if="rowCount !== undefined">
              · 已交付 {{ rowCount.toLocaleString() }} 行</span
            ></span
          ></span
        >
      </div>
      <div class="result-controls">
        <ElSelect v-model="kind" aria-label="结果展示方式" class="chart-kind"
          ><ElOption label="表格" value="table" /><ElOption label="柱状图" value="bar" /><ElOption
            label="折线图"
            value="line" /><ElOption label="饼图" value="pie"
        /></ElSelect>
        <ElPopover trigger="click" placement="bottom-end" :width="260"
          ><template #reference><ElButton>显示列</ElButton></template
          ><ElCheckboxGroup v-model="visibleColumns" aria-label="显示列"
            ><ElCheckbox
              v-for="column in table.columns"
              :key="column.name"
              :value="column.name"
              :disabled="visibleColumns.length === 1 && visibleColumns.includes(column.name)"
              >{{ column.name }}</ElCheckbox
            ></ElCheckboxGroup
          ></ElPopover
        >
        <slot name="actions" />
      </div>
    </div>
    <p v-if="truncated" class="result-notice">结果已截断，当前行数是已交付量，业务总量未知。</p>
    <p v-else-if="sampled" class="result-notice">
      当前是预览样本，读取已保存依据后可查看本次交付的完整结果。
    </p>
    <p v-if="!table.rows.length" class="result-notice">查询已返回，当前条件下没有数据。</p>
    <template v-else-if="kind === 'table'">
      <div
        class="virtual-table"
        data-testid="virtual-table"
        :style="{ height: `${Math.min(340, 40 + rows.length * 40 + 8)}px` }"
      >
        <ElAutoResizer
          ><template #default="{ width, height }"
            ><ElTableV2
              :width="width"
              :height="height"
              :columns="fittedColumns(width)"
              :data="rows"
              row-key="position"
              :row-height="40"
              :header-height="40"
              fixed /></template
        ></ElAutoResizer>
      </div>
      <ElPagination
        v-if="table.rows.length > size || size !== 100"
        v-model:page-size="size"
        :current-page="paged.page"
        :page-sizes="[50, 100, 200]"
        :total="table.rows.length"
        layout="prev, pager, next, sizes"
        :pager-count="5"
        @update:current-page="page = $event"
      />
    </template>
    <template v-else>
      <div class="chart-fields">
        <label
          >维度<ElSelect v-model="dimension" aria-label="图表维度"
            ><ElOption
              v-for="column in table.columns"
              :key="column.name"
              :label="column.name"
              :value="column.name" /></ElSelect></label
        ><label
          >数值<ElSelect v-model="metric" aria-label="图表数值"
            ><ElOption
              v-for="column in numericColumns"
              :key="column.name"
              :label="column.name"
              :value="column.name" /></ElSelect
        ></label>
      </div>
      <ResultChart :table="table" :kind="kind" :dimension="dimension" :metric="metric" />
    </template>
    <ElButton v-if="canLoad" class="evidence-load" :loading="loading" @click="$emit('load')"
      >读取完整已保存结果</ElButton
    >
    <ElDrawer
      :model-value="cell !== null"
      title="单元格内容"
      size="min(560px, 100vw)"
      @close="cell = null"
    >
      <pre class="plain-content">{{ cell }}</pre>
    </ElDrawer>
  </section>
</template>
