import { generateExport } from "../../../src/features/exports/export-runtime";
import type { ExportJob } from "../../../src/features/exports/export-types";
/** 容量样例绕过业务查询，只衡量已经固定的本地导出数据，不宣称 API 查询支持十万行。 */
async function runExportCapacity(cancel: boolean) {
  const nativeWorker = window.Worker;
  let created = 0,
    terminated = 0;
  window.Worker = class extends nativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      created++;
    }
    override terminate() {
      terminated++;
      super.terminate();
    }
  };
  const job: ExportJob = {
    format: "xlsx",
    fontBase: "",
    summaryRows: 100,
    tableIds: [],
    document: {
      title: "容量验收100000行",
      metadata: ["生成器专项：20 表 × 5,000 行；不调用 API 或模型。"],
      blocks: [],
      tables: Array.from({ length: 20 }, (_, table) => ({
        id: `table-${table}`,
        title: `表 ${table + 1}`,
        createdAt: "2026-09-28 00:00:00",
        complete: true,
        result: {
          columns: [
            { name: "编码", data_type: "string" },
            { name: "数值", data_type: "integer" },
            { name: "启用", data_type: "boolean" },
            { name: "备注", data_type: "string" },
          ],
          rows: Array.from({ length: 5000 }, (_, row) => ({
            编码: `${table}-${String(row).padStart(6, "0")}`,
            数值: table * 5000 + row,
            启用: row % 2 === 0,
            备注: row % 3 === 0 ? null : "=1+1",
          })),
          row_count: 5000,
          truncated: false,
        },
      })),
    },
  };
  job.tableIds = job.document.tables.map((t) => t.id);
  const controller = new AbortController(),
    start = performance.now();
  let last = start,
    maxGap = 0,
    ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 16);
  try {
    const buffer = await generateExport(job, controller.signal, (stage) => {
      if (cancel && stage.startsWith("正在写入表格")) controller.abort();
    });
    return {
      cancelled: false,
      created,
      terminated,
      ticks,
      maxGap,
      duration: performance.now() - start,
      bytes: Array.from(new Uint8Array(buffer)),
    };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return {
      cancelled: true,
      created,
      terminated,
      ticks,
      maxGap,
      duration: performance.now() - start,
      bytes: [],
    };
  } finally {
    clearInterval(timer);
    window.Worker = nativeWorker;
  }
}
Object.assign(window, { runExportCapacity });
