import { describe, expect, it } from "vitest";
import { MAX_QUERY_TABLE_BYTES, type QueryResult } from "@ai-data/contracts";
import { assertResultBudget } from "../../src/connectors/result-budget";

describe("标准化明细容量", () => {
  const columns: QueryResult["columns"] = [{ name: "text", data_type: "string" }];
  it("接受五万行正常明细", () => {
    expect(() =>
      assertResultBudget({
        columns,
        rows: Array.from({ length: 50000 }, () => ({ text: "就诊记录" })),
      }),
    ).not.toThrow();
  });
  it("按 UTF-8 字节拒绝少量但内容超大的行", () => {
    expect(() =>
      assertResultBudget({
        columns,
        rows: [{ text: "中".repeat(Math.ceil(MAX_QUERY_TABLE_BYTES / 3)) }],
      }),
    ).toThrowError(expect.objectContaining({ code: "QUERY_LIMIT_EXCEEDED" }));
  });
});
