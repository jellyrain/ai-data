import ExcelJS from "exceljs";
import { checkExportBudget, exportCell, selectExportTables, sheetNames } from "./export-model";
import type { ExportJob } from "./export-types";
/** 浏览器文档模型保留完整值类型，不向公式或超链接对象转换业务文字。 */
async function generateSpreadsheet(
  job: ExportJob,
  stage: (value: string) => void,
): Promise<ArrayBuffer> {
  const tables = selectExportTables(job.document, job.tableIds);
  checkExportBudget(tables, job.document.blocks);
  const workbook = new ExcelJS.Workbook(),
    metadata = workbook.addWorksheet("导出说明");
  const text = (value: string) => {
    if (value.length > 32767) throw new Error("单元格超过 32,767 字符，请缩小字段内容后导出");
    return value;
  };
  metadata.addRows([
    [text(job.document.title)],
    ["完整表格包含全部已保存行与列；NULL 为留空，公式样文本为普通字符串。"],
    ...job.document.metadata.map((value) => [text(value)]),
    ...job.document.tables.map((t) => [
      text(t.title),
      t.complete ? (job.tableIds.includes(t.id) ? "已选择" : "未选择") : "已截断，未导出明细",
      t.result.rows.length,
    ]),
  ]);
  metadata.getColumn(1).width = 80;
  const names = sheetNames(tables.map((table) => table.title));
  for (const [index, table] of tables.entries()) {
    stage(`正在写入表格 ${index + 1} / ${tables.length}`);
    const sheet = workbook.addWorksheet(names[index]!, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(table.result.columns.map((column) => text(column.name)));
    for (const row of table.result.rows)
      sheet.addRow(
        table.result.columns.map((column) => {
          const value = exportCell(row[column.name], column.data_type);
          return typeof value === "string" ? text(value) : value;
        }),
      );
    sheet.getRow(1).font = { bold: true, color: { argb: "FF243B36" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0EC" } };
    sheet.columns.forEach((column) => {
      column.width = 22;
    });
    if (table.result.columns.length)
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, sheet.rowCount), column: table.result.columns.length },
      };
  }
  stage("正在压缩 Excel 文件");
  return new Uint8Array(await workbook.xlsx.writeBuffer()).buffer;
}
export { generateSpreadsheet };
