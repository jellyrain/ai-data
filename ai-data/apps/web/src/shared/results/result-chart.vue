<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { use } from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  AriaComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import VChart from "vue-echarts";
import type { QueryResult } from "@ai-data/contracts";
import { createChartData } from "./result-model";
const props = defineProps<{
  table: Pick<QueryResult, "columns" | "rows">;
  kind: "bar" | "line" | "pie";
  dimension: string;
  metric: string;
}>();
use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  AriaComponent,
  CanvasRenderer,
]);
const colors = ref({
  primary: "#686c2b",
  text: "#23242b",
  border: "#e4e4e9",
  panel: "#fff",
  secondary: "#16796d",
});
let observer: MutationObserver | undefined;
function readColors() {
  const styles = getComputedStyle(document.documentElement);
  colors.value = {
    primary: styles.getPropertyValue("--app-primary").trim(),
    text: styles.getPropertyValue("--app-text").trim(),
    border: styles.getPropertyValue("--app-border").trim(),
    panel: styles.getPropertyValue("--app-panel").trim(),
    secondary:
      styles.getPropertyValue("--app-chart-teal").trim() ||
      styles.getPropertyValue("--app-muted").trim(),
  };
}
const data = computed(() => {
  try {
    if (props.table.rows.length > 5000)
      throw new Error("当前结果超过 5,000 行，请缩小范围后绘图；表格可继续查看全部已交付数据");
    return {
      value: createChartData(props.table, props.kind, props.dimension, props.metric),
      error: "",
    };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : "当前字段无法绘图" };
  }
});
const option = computed(() => {
  const value = data.value.value;
  if (!value) return {};
  const palette = colors.value;
  const common = {
    animation: false,
    color: [palette.primary, palette.secondary],
    backgroundColor: "transparent",
    textStyle: { color: palette.text, fontFamily: "system-ui" },
    aria: { enabled: true, decal: { show: props.kind === "pie" } },
    tooltip: {
      renderMode: "richText" as const,
      backgroundColor: palette.panel,
      textStyle: { color: palette.text },
      borderColor: palette.border,
    },
  };
  if (props.kind === "pie")
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: "item" },
      series: [
        {
          type: "pie",
          radius: "65%",
          label: { color: palette.text, overflow: "truncate", width: 100 },
          data: value.labels.map((name, index) => ({ name, value: value.values[index] })),
        },
      ],
    };
  return {
    ...common,
    grid: { left: 60, right: 24, top: 24, bottom: value.labels.length > 30 ? 78 : 44 },
    tooltip: { ...common.tooltip, trigger: "axis" },
    xAxis: {
      type: "category",
      data: value.labels,
      axisLabel: { color: palette.text, overflow: "truncate", width: 80 },
      axisLine: { lineStyle: { color: palette.border } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.text },
      splitLine: { lineStyle: { color: palette.border, type: "dashed" } },
    },
    dataZoom:
      value.labels.length > 30
        ? [
            {
              type: "slider",
              start: 0,
              end: (30 / value.labels.length) * 100,
              textStyle: { color: palette.text },
              borderColor: palette.border,
            },
          ]
        : [],
    series: [
      {
        type: props.kind,
        data: value.values,
        smooth: false,
        barMaxWidth: 48,
        itemStyle: props.kind === "bar" ? { borderRadius: [3, 3, 0, 0] } : undefined,
        showSymbol: value.values.length < 100,
      },
    ],
  };
});
onMounted(() => {
  readColors();
  observer = new MutationObserver(readColors);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-palette"],
  });
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <p v-if="data.error" class="result-notice" role="status">{{ data.error }}</p>
  <VChart
    v-else
    class="result-chart"
    :option="option"
    autoresize
    :aria-label="`${dimension}与${metric}图表，${table.rows.length}条已交付数据`"
  />
</template>
