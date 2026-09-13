import { describe, expect, it } from "vitest";

import { connectorExecutionResultSchema } from "../../src/connectors/connector-result";

// 这里检查结果结构和行数一致性，记录中的单元格类型由具体连接器处理。
describe("连接器标准化结果", () => {
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
