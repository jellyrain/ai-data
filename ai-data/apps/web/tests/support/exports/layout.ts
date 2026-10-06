import { generateExport } from "../../../src/features/exports/export-runtime";
import type { ExportJob } from "../../../src/features/exports/export-types";
/** 使用生产生成器检验最长标题、宽表、长代码、多个图形和空文档。 */
async function runDocumentLayout(format: "pdf" | "docx", empty: boolean) {
  const job: ExportJob = {
    format,
    fontBase: new URL("/fonts/noto-sans-sc/", location.href).href,
    summaryRows: 200,
    tableIds: empty ? [] : ["wide"],
    document: {
      title: empty ? "空文档验收" : "住院医疗费用与科室分析".repeat(35),
      metadata: ["固定条件：2026-01-01 至 2026-09-27；金额单位：分。"],
      blocks: empty
        ? []
        : [
            {
              kind: "code",
              text: Array.from(
                { length: 45 },
                (_, index) =>
                  `第 ${index + 1} 行：SELECT department, amount_cents FROM fixed_result WHERE department = '心血管内科';`,
              ).join("\n"),
            },
            {
              kind: "chart",
              tableId: "wide",
              title: "住院金额",
              chart: { type: "bar", x: "科室", y: "金额" },
            },
            {
              kind: "diagram",
              source: "flowchart LR\nA[已授权结果] --> B[生成文件] --> C[复核下载]",
            },
          ],
      tables: empty
        ? []
        : [
            {
              id: "wide",
              title: "住院宽表",
              complete: true,
              createdAt: "2026-09-28 00:00:00",
              result: {
                columns: ["科室", "金额", "备注", "月份", "编码", "启用", "末列"].map((name) => ({
                  name,
                  data_type: name === "金额" ? "integer" : name === "启用" ? "boolean" : "string",
                })),
                rows: Array.from({ length: 200 }, (_, index) => ({
                  科室: `科室 ${index + 1}`,
                  金额: index * 1234,
                  备注:
                    index % 40 === 0
                      ? "长内容中文需要正常换行，末尾必须可读。".repeat(5)
                      : "完整记录",
                  月份: "2026-09",
                  编码: String(index).padStart(6, "0"),
                  启用: true,
                  末列: `终值${index + 1}`,
                })),
                row_count: 200,
                truncated: false,
              },
            },
          ],
    },
  };
  return Array.from(
    new Uint8Array(await generateExport(job, new AbortController().signal, () => {})),
  );
}
Object.assign(window, { runDocumentLayout });
