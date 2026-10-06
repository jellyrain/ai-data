import { exportCell, selectExportTables } from "./export-model";
import type { DocumentBlock, ExportJob } from "./export-types";
/** 页眉用单行摘要，完整标题继续保留在正文及文件属性中。 */
function documentHeader(title: string): string {
  const characters = Array.from(title.replace(/\s+/g, " ").trim());
  return characters.slice(0, 60).join("") + (characters.length > 60 ? "…" : "");
}
/** 文档保留文字与图形，明细按用户选择给出有界摘要；宽表分列组带稳定行号。 */
function documentLayout(job: ExportJob): DocumentBlock[] {
  const tables = selectExportTables(job.document, job.tableIds);
  if (tables.reduce((sum, t) => sum + Math.min(job.summaryRows, t.result.rows.length), 0) > 2000)
    throw new Error("文档摘要总量最多 2,000 行");
  const blocks: DocumentBlock[] = [
    { kind: "heading", level: 1, runs: [{ text: job.document.title }] },
    ...job.document.metadata.map((text) => ({ kind: "paragraph" as const, runs: [{ text }] })),
    ...job.document.blocks,
  ];
  for (const table of tables) {
    const count = Math.min(job.summaryRows, table.result.rows.length);
    blocks.push(
      { kind: "heading", level: 2, runs: [{ text: table.title }] },
      {
        kind: "paragraph",
        runs: [
          {
            text: `摘要 ${count} / ${table.result.rows.length} 行；完整明细请导出 Excel。来源 ${table.id}`,
          },
        ],
      },
    );
    if (!table.result.rows.length)
      blocks.push({ kind: "paragraph", runs: [{ text: "本次查询返回 0 行，以下保留列名。" }] });
    for (let offset = 0; offset < table.result.columns.length; offset += 5) {
      const columns = table.result.columns.slice(offset, offset + 5);
      if (table.result.columns.length > 5)
        blocks.push({
          kind: "paragraph",
          runs: [
            {
              text: `列组 ${Math.floor(offset / 5) + 1} / ${Math.ceil(table.result.columns.length / 5)}，按行号对应。`,
            },
          ],
        });
      blocks.push({
        kind: "table",
        rows: [
          ["行号", ...columns.map((c) => c.name)],
          ...table.result.rows.slice(0, count).map((row, index) => [
            String(index + 1),
            ...columns.map((column) => {
              const value = exportCell(row[column.name], column.data_type);
              return value === null ? "NULL" : String(value);
            }),
          ]),
        ],
      });
    }
  }
  return blocks;
}
/** 生成库不接收未渲染的图形；失败时保留具体说明和流程图源码。 */
function unresolvedText(block: DocumentBlock): string {
  return block.kind === "chart"
    ? `${block.title}：图表未生成，请查看来源表格。`
    : block.kind === "diagram"
      ? `流程图未生成，源码：\n${block.source}`
      : "";
}
export { documentLayout, documentHeader, unresolvedText };
