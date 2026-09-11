import { describe, expect, it } from "vitest";

import { queryResultSchema } from "../../src/query/query-result";

describe("查询结果合同", () => {
  // BDD 场景：Data Access Service 返回已标准化的查询结果；TDD 断言：调用方只接收结果表本身。
  it("接受标准化查询结果", () => {
    const result = queryResultSchema.parse({
      columns: [{ name: "visit_count", data_type: "integer" }],
      rows: [{ visit_count: 100 }],
      row_count: 1,
      truncated: false,
    });

    expect(result.row_count).toBe(1);
  });

  // BDD 场景：调用方尝试把内部审计信息带入公开结果；TDD 断言：结果合同拒绝额外字段。
  it("拒绝内部审计字段", () => {
    expect(
      queryResultSchema.safeParse({
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        evidence: {},
      }).success,
    ).toBe(false);
  });
});
