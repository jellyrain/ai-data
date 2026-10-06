import { describe, it, expect } from "vitest";
import {
  exportDocument,
  checkExportBudget,
  selectExportTables,
  safeFileName,
  sheetNames,
} from "../../../src/features/exports/export-model";
import { markdownDocument } from "../../../src/features/exports/markdown-document";
import { execution, evidence } from "./fixtures";
describe("固定授权内容转换", () => {
  it("导出说明保留固定查询中的实际筛选值", () => {
    const record = structuredClone(execution),
      query = record.results[0]!.evidence.authorized_query;
    if (query.type !== "relational_query") throw new Error("验收需要关系查询");
    query.filters = {
      logic: "and",
      items: [{ field: "v.count", op: "eq", value: 20, data_type: "integer" }],
    };
    const model = exportDocument(
      { kind: "report_execution", execution: record, narratives: [] },
      { kind: "execution", id: "execution", reportId: "report" },
      "org",
    );
    expect(model.metadata.join(" ")).toContain('"field":"v.count"');
    expect(model.metadata.join(" ")).toContain('"value":20');
  });
  it("执行使用实际参数与全部来源列，不受展示列和重复块影响", () => {
    const pack = { kind: "report_execution" as const, execution, narratives: [] };
    const result = exportDocument(
      pack,
      { kind: "execution", id: "execution", reportId: "report" },
      "org",
    );
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.result).toEqual(evidence.result);
    expect(result.metadata.join(" ")).toContain('"min":0');
    expect(() =>
      exportDocument(pack, { kind: "execution", id: "other", reportId: "report" }, "org"),
    ).toThrow();
    expect(() =>
      exportDocument(pack, { kind: "execution", id: "execution", reportId: "report" }, "other"),
    ).toThrow();
  });
  it("截断来源保留完整性说明，不能被选择为完整明细", () => {
    const truncated = { ...evidence, result: { ...evidence.result, truncated: true } };
    const report = { ...execution.snapshot!, sources: [truncated] };
    const model = exportDocument(
      { kind: "report", report, tables: [{ evidence: truncated, availability: "truncated" }] },
      { kind: "snapshot", id: "report", version: 1 },
      "org",
    );
    expect(model.tables[0]!.complete).toBe(false);
    expect(selectExportTables(model, [evidence.evidence_id])).toHaveLength(0);
    expect(model.metadata.join(" ")).toContain("截断");
  });
  it("正文和总行数有显式边界，空表可导出", () => {
    const model = exportDocument(
      { kind: "report_execution", execution, narratives: [] },
      { kind: "execution", id: "execution", reportId: "report" },
      "org",
    );
    const table = { ...model.tables[0]!, result: { ...model.tables[0]!.result, rows: [] } };
    expect(() => checkExportBudget([table], [])).not.toThrow();
    expect(() =>
      checkExportBudget(
        Array.from({ length: 100 }, () => table),
        [],
      ),
    ).not.toThrow();
    expect(() =>
      checkExportBudget(
        Array.from({ length: 101 }, () => table),
        [],
      ),
    ).toThrow("100 张表");
    expect(() =>
      checkExportBudget(
        [
          {
            ...table,
            result: { ...table.result, rows: [{ value: "x".repeat(32 * 1024 * 1024) }] },
          },
        ],
        [],
      ),
    ).toThrow("32 MiB");
    expect(() =>
      checkExportBudget(
        [
          {
            ...table,
            result: { ...table.result, rows: Array.from({ length: 100001 }, () => ({})) },
          },
        ],
        [],
      ),
    ).toThrow("100,000");
    expect(() =>
      checkExportBudget([], [{ kind: "paragraph", runs: [{ text: "文".repeat(710000) }] }]),
    ).toThrow("2 MiB");
  });
  it("文件与工作表名称去除保留字符并保持唯一", () => {
    expect(safeFileName("住院/费用:*?")).toBe("住院_费用___");
    const names = sheetNames(["导出说明", "A/B", "A:B", "x".repeat(60)]);
    expect(new Set(names).size).toBe(4);
    expect(names.every((n) => n.length <= 31)).toBe(true);
    expect(names[0]).not.toBe("导出说明");
  });
  it("Markdown 形成可编辑节点，外部图片为说明，危险链接不变为超链接", () => {
    const blocks = markdownDocument(
      "# 标题\n\n**粗体**与[网站](https://example.com)\n\n- 事项\n\n|列|值|\n|-|-|\n|甲|1|\n\n![图片](https://example.com/a.png)\n\n```mermaid\nflowchart LR\nA-->B\n```",
    );
    expect(blocks.some((b) => b.kind === "heading")).toBe(true);
    expect(blocks.some((b) => b.kind === "table")).toBe(true);
    expect(blocks.some((b) => b.kind === "diagram")).toBe(true);
    expect(JSON.stringify(blocks)).toContain("图片：图片");
    expect(JSON.stringify(markdownDocument("[危险](javascript:alert(1))"))).not.toContain('"href"');
  });
});
