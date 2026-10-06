import { describe, expect, it } from "vitest";
import type { QueryResult } from "@ai-data/contracts";
import { createChartData, formatCell, pageRows } from "../../../src/shared/results/result-model";

const result: QueryResult = {
  columns: [
    { name: "科室", data_type: "string" },
    { name: "人次", data_type: "integer" },
  ],
  rows: [
    { 科室: "门诊", 人次: 20 },
    { 科室: "住院", 人次: 10 },
  ],
  row_count: 2,
  truncated: false,
};

describe("已交付结果的本地分页与受控图表", () => {
  it.each([1000, 10000, 50000, 100000])("%i 行只切出当前页，原始行保持引用", (count) => {
    const rows = Array.from({ length: count }, (_, id) => ({ id }));
    const page = pageRows(rows, 2, 100);
    expect(page.page).toBe(2);
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]).toBe(rows[100]);
    expect(rows).toHaveLength(count);
  });

  it("页大小变化和空结果会修正越界页码", () => {
    expect(pageRows(result.rows, 80, 200)).toEqual({ page: 1, pages: 1, rows: result.rows });
    expect(pageRows([], 9, 50)).toEqual({ page: 1, pages: 1, rows: [] });
    expect(() => pageRows(result.rows, 1, 500)).toThrow();
  });

  it("NULL、零、布尔和原始日期值保持含义", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(0)).toBe("0");
    expect(formatCell(false)).toBe("false");
    expect(formatCell("2026-09-27 08:00:00")).toBe("2026-09-27 08:00:00");
  });

  it("柱图仅从有效维度与数值生成分类和值", () => {
    expect(createChartData(result, "bar", "科室", "人次")).toEqual({
      labels: ["门诊", "住院"],
      values: [20, 10],
    });
    expect(() => createChartData(result, "bar", "不存在", "人次")).toThrow();
    expect(() => createChartData(result, "line", "科室", "科室")).toThrow();
  });

  it("重复分类、NULL 和负值饼图给出说明，不能静默聚合或丢弃", () => {
    expect(() =>
      createChartData({ ...result, rows: [result.rows[0], result.rows[0]] }, "bar", "科室", "人次"),
    ).toThrow();
    expect(() =>
      createChartData({ ...result, rows: [{ 科室: "门诊", 人次: null }] }, "bar", "科室", "人次"),
    ).toThrow();
    expect(() =>
      createChartData({ ...result, rows: [{ 科室: "门诊", 人次: -1 }] }, "pie", "科室", "人次"),
    ).toThrow();
    expect(() => createChartData({ ...result, rows: [] }, "line", "科室", "人次")).toThrow();
  });
});
