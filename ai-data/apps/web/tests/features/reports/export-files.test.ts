// 二进制文件检验使用 Node 运行，浏览器 Worker 与排版由生产预览验收覆盖。
// @vitest-environment node
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { generateSpreadsheet } from "../../../src/features/exports/spreadsheet";
import { generateWord } from "../../../src/features/exports/word";
import type { ExportJob } from "../../../src/features/exports/export-types";
const job: ExportJob = {
  format: "xlsx",
  fontBase: "",
  summaryRows: 50,
  tableIds: ["table", "empty"],
  document: {
    title: "住院与费用",
    metadata: ["实际条件：本年"],
    blocks: [
      { kind: "heading", level: 2, runs: [{ text: "业务说明" }] },
      {
        kind: "paragraph",
        runs: [
          { text: "可编辑中文", bold: true },
          { text: "资料", href: "https://example.com" },
        ],
      },
    ],
    tables: [
      {
        id: "table",
        title: "费用/明细",
        complete: true,
        createdAt: "2026-09-28 10:00:00",
        result: {
          columns: [
            { name: "编码", data_type: "string" },
            { name: "金额", data_type: "decimal" },
            { name: "有效", data_type: "boolean" },
            { name: "备注", data_type: "string" },
          ],
          rows: [
            { 编码: "00123", 金额: 12345.67, 有效: true, 备注: "=1+1" },
            { 编码: "00000", 金额: 0, 有效: false, 备注: null },
          ],
          row_count: 2,
          truncated: false,
        },
      },
      {
        id: "empty",
        title: "空表",
        complete: true,
        createdAt: "2026-09-28 10:00:00",
        result: {
          columns: [{ name: "列", data_type: "string" }],
          rows: [],
          row_count: 0,
          truncated: false,
        },
      },
    ],
  },
};
describe("业务导出文件内容", () => {
  it("长标题正文完整保留，页眉采用可读摘要", async () => {
    const copy = structuredClone(job);
    copy.document.title = "住院医疗费用与科室分析".repeat(35);
    const zip = unzipSync(new Uint8Array(await generateWord(copy, () => {})));
    expect(strFromU8(zip["word/document.xml"]!)).toContain(copy.document.title);
    const header = strFromU8(zip["word/header1.xml"]!);
    expect(header).not.toContain(copy.document.title);
    expect(header).toContain(copy.document.title.slice(0, 60) + "…");
  });
  it("Excel 保存所有列和值类型，空表保留表头，公式样文本保持文字", async () => {
    const buffer = await generateSpreadsheet(job, () => {}),
      book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer);
    expect(book.worksheets).toHaveLength(3);
    const sheet = book.worksheets[1]!;
    expect(sheet.getRow(2).values).toEqual([undefined, "00123", 12345.67, true, "=1+1"]);
    expect(sheet.getCell("D3").value).toBeNull();
    expect(book.worksheets[2]!.getCell("A1").value).toBe("列");
    const xml = Object.values(unzipSync(new Uint8Array(buffer)))
      .map((value) => strFromU8(value))
      .join("");
    expect(xml).not.toContain("<f>");
  });
  it("超长单元格明确失败而非截断", async () => {
    const copy = structuredClone(job);
    copy.document.tables[0]!.result.rows[0]!.备注 = "长".repeat(32768);
    await expect(generateSpreadsheet(copy, () => {})).rejects.toThrow("32,767");
  });
  it("Word 生成真实段落表格、摘要说明和链接，长表不省略标记", async () => {
    const copy = structuredClone(job);
    const table = copy.document.tables[0]!;
    table.result.rows = Array.from({ length: 51 }, (_, i) => ({
      编码: `00${i}`,
      金额: i,
      有效: true,
      备注: "内容",
    }));
    table.result.row_count = 51;
    const output = await generateWord(copy, () => {});
    const zip = unzipSync(new Uint8Array(output));
    const xml = strFromU8(zip["word/document.xml"]!);
    expect(xml).toContain('w:orient="portrait"');
    expect(xml).toContain("可编辑中文");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("<w:tblHeader");
    expect(xml).toContain("50 / 51");
    expect(xml).not.toContain(">0050<");
    expect(strFromU8(zip["word/_rels/document.xml.rels"]!)).toContain("https://example.com");
  });
  it("宽表按列组保留行号，并采用横向页面", async () => {
    const copy = structuredClone(job);
    copy.document.tables = [
      {
        ...copy.document.tables[0]!,
        result: {
          columns: Array.from({ length: 7 }, (_, i) => ({
            name: `列${i}`,
            data_type: "string" as const,
          })),
          rows: [Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`列${i}`, `值${i}`]))],
          row_count: 1,
          truncated: false,
        },
      },
    ];
    const xml = strFromU8(
      unzipSync(new Uint8Array(await generateWord(copy, () => {})))["word/document.xml"]!,
    );
    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(xml).toContain("列组 2 / 2");
    expect(xml).toContain("值6");
  });
});
