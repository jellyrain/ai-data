import { describe, expect, it } from "vitest";

import { queryResultSchema } from "../../src/query/query-result";

// 查询结果外层只承载表格与结果元数据，审计关联信息使用独立记录。
describe("查询结果合同", () => {
  it.each([
    {
      columns: [
        { name: "id", data_type: "integer" },
        { name: "id", data_type: "integer" },
      ],
      rows: [{ id: 1 }],
      row_count: 1,
    },
    { columns: [{ name: "id", data_type: "integer" }], rows: [{ id: "12" }], row_count: 1 },
    { columns: [{ name: "id", data_type: "integer" }], rows: [{ id: 1, extra: {} }], row_count: 1 },
    { columns: [{ name: "id", data_type: "integer" }], rows: [{}], row_count: 1 },
    { columns: [], rows: [], row_count: 1 },
    {
      columns: [{ name: "id", data_type: "integer" }],
      rows: [{ id: 9007199254740992 }],
      row_count: 1,
    },
    { columns: [{ name: "id", data_type: "decimal" }], rows: [{ id: Infinity }], row_count: 1 },
  ])("拒绝与声明不一致的查询结果 %#", (value) => {
    expect(queryResultSchema.safeParse({ ...value, truncated: false }).success).toBe(false);
  });

  it("接受空结果、可空单元格及空二进制", () => {
    expect(
      queryResultSchema.safeParse({
        columns: [{ name: "id", data_type: "integer" }],
        rows: [],
        row_count: 0,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      queryResultSchema.safeParse({
        columns: [
          { name: "id", data_type: "integer" },
          { name: "data", data_type: "buffer" },
        ],
        rows: [{ id: null, data: "" }],
        row_count: 1,
        truncated: false,
      }).success,
    ).toBe(true);
  });
  it("接受标准化查询结果", () => {
    const result = queryResultSchema.parse({
      columns: [{ name: "visit_count", data_type: "integer" }],
      rows: [{ visit_count: 100 }],
      row_count: 1,
      truncated: false,
    });

    expect(result.row_count).toBe(1);
  });

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
