import { describe, expect, it } from "vitest";
import type { QueryResult } from "@ai-data/contracts";
import {
  parseAnalysisQuery,
  assertAnalysisResultBudget,
  sampleAnalysisRows,
} from "../../src/analysis-runs/analysis-query";

describe("分析结果与明细交付的容量边界", () => {
  const query = {
    type: "relational_query",
    source_id: "s",
    from: { object_id: "visits", alias: "v" },
    select: [{ field: "v.id" }],
  };
  it("省略上限时仍使用五千行证据预算，拒绝大明细进入运行查询", () => {
    expect(parseAnalysisQuery(query).limit).toBe(5000);
    expect(() => parseAnalysisQuery({ ...query, limit: 50000 })).toThrowError(
      expect.objectContaining({ code: "QUERY_LIMIT_EXCEEDED" }),
    );
  });
  it("宽行响应超出证据预算时拒绝持久化", () => {
    const result: QueryResult = {
      columns: [{ name: "text", data_type: "string" }],
      rows: [{ text: "中".repeat(800000) }],
      row_count: 1,
      truncated: false,
    };
    expect(() => assertAnalysisResultBudget(result)).toThrowError(
      expect.objectContaining({ code: "QUERY_LIMIT_EXCEEDED" }),
    );
  });
  it("SSE 最多一百行，宽行还受样本字节预算限制", () => {
    const result: QueryResult = {
      columns: [{ name: "text", data_type: "string" }],
      rows: Array.from({ length: 200 }, () => ({ text: "记录" })),
      row_count: 200,
      truncated: false,
    };
    expect(sampleAnalysisRows(result)).toHaveLength(100);
    const wide = { ...result, rows: [{ text: "中".repeat(100000) }], row_count: 1 };
    expect(sampleAnalysisRows(wide)).toHaveLength(0);
  });
});
