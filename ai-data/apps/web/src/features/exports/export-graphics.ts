import { use, init } from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { createChartData } from "../../shared/results/result-model";
import { renderDiagram } from "../../shared/content/diagram";
import type { DocumentBlock, ExportJob } from "./export-types";
use([BarChart, LineChart, PieChart, GridComponent, CanvasRenderer]);
async function diagramImage(source: string, signal: AbortSignal): Promise<DocumentBlock> {
  const svg = await renderDiagram(source, true);
  signal.throwIfAborted();
  const element = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const bounds = element.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const originalWidth = bounds?.[2] || 1000,
    originalHeight = bounds?.[3] || 600;
  const scale = Math.min(1200 / originalWidth, 900 / originalHeight),
    width = Math.round(originalWidth * scale),
    height = Math.round(originalHeight * scale);
  element.setAttribute("width", String(width));
  element.setAttribute("height", String(height));
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        image.src = "";
        reject(new DOMException("已取消", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      image.onload = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      image.onerror = () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("流程图图像读取失败"));
      };
      image.src = url;
    });
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图像绘制不可用");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return { kind: "image", data: canvas.toDataURL("image/png"), width, height, caption: "流程图" };
  } finally {
    URL.revokeObjectURL(url);
  }
}
/** 从固定的完整结果绘图，不读取屏幕缩放、分页或当前主题颜色。 */
async function prepareGraphics(
  job: ExportJob,
  signal: AbortSignal,
  stage: (value: string) => void,
): Promise<ExportJob> {
  const blocks: DocumentBlock[] = [];
  for (const block of job.document.blocks) {
    signal.throwIfAborted();
    if (block.kind !== "chart" && block.kind !== "diagram") {
      blocks.push(block);
      continue;
    }
    stage("正在准备图表和流程图");
    try {
      if (block.kind === "diagram") blocks.push(await diagramImage(block.source, signal));
      else {
        const table = job.document.tables.find(
          (table) =>
            table.id === block.tableId && table.complete && job.tableIds.includes(table.id),
        );
        if (!table) {
          blocks.push({
            kind: "paragraph",
            runs: [{ text: `${block.title}：来源表格未选中或结果已截断，未生成图表。` }],
          });
          continue;
        }
        const values = createChartData(
          table.result,
          block.chart.type,
          block.chart.x,
          block.chart.y,
        );
        const canvas = document.createElement("canvas");
        canvas.width = 1200;
        canvas.height = 600;
        const chart = init(canvas, undefined, {
          width: 1200,
          height: 600,
          renderer: "canvas",
          devicePixelRatio: 1,
        });
        try {
          const common = {
            animation: false,
            backgroundColor: "#fff",
            color: ["#4f6e60", "#367a91", "#947650", "#7771a0"],
            textStyle: { color: "#26382e", fontFamily: "system-ui", fontSize: 15 },
          };
          chart.setOption(
            block.chart.type === "pie"
              ? {
                  ...common,
                  series: [
                    {
                      type: "pie",
                      radius: "65%",
                      data: values.labels.map((name, index) => ({
                        name,
                        value: values.values[index],
                      })),
                    },
                  ],
                }
              : {
                  ...common,
                  grid: { left: 90, right: 30, top: 30, bottom: 80 },
                  xAxis: {
                    type: "category",
                    data: values.labels,
                    axisLabel: { hideOverlap: true },
                  },
                  yAxis: { type: "value" },
                  series: [
                    {
                      type: block.chart.type,
                      data: values.values,
                      showSymbol: values.values.length < 100,
                    },
                  ],
                },
          );
          blocks.push({
            kind: "image",
            data: chart.getDataURL({ type: "png", backgroundColor: "#fff" }),
            width: 1200,
            height: 600,
            caption: `${block.title} · 全部 ${table.result.rows.length} 行 · ${table.id}`,
          });
        } finally {
          chart.dispose();
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      blocks.push({
        kind: "paragraph",
        runs: [
          {
            text: `${block.kind === "chart" ? block.title : "流程图"}生成失败：${error instanceof Error ? error.message : "无法绘制"}。`,
          },
        ],
      });
      if (block.kind === "diagram") blocks.push({ kind: "code", text: block.source });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { ...job, document: { ...job.document, blocks } };
}
export { prepareGraphics };
