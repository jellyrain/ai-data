import { describe, expect, it } from "vitest";

import { connectorExecutionResultSchema } from "../../src/connectors/connector-result";

describe("连接器标准化结果", () => {
  // BDD 场景：连接器完成一次只读查询；TDD 断言：它只返回统一表格，不携带 SQL、URL、凭据或权限上下文。
  it("接受行数与返回行一致的统一表格结果", () => {
    const result = connectorExecutionResultSchema.parse({
      columns: [{ name: "surgery_count", data_type: "integer" }],
      rows: [{ surgery_count: 12 }],
      row_count: 1,
      truncated: false,
      freshness: "2026-08-28 09:00:00",
    });

    expect(result.rows[0]).toEqual({ surgery_count: 12 });
  });

  // BDD 场景：连接器报告了与实际表格不一致的返回行数；TDD 断言：DAS 拒绝该不可信的标准化结果。
  it("拒绝与返回行数不一致的 row_count", () => {
    expect(
      connectorExecutionResultSchema.safeParse({
        columns: [{ name: "surgery_count", data_type: "integer" }],
        rows: [{ surgery_count: 12 }],
        row_count: 2,
        truncated: false,
      }).success,
    ).toBe(false);
  });
});
