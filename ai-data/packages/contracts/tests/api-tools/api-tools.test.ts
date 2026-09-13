import { describe, expect, it } from "vitest";

import { queryDatasetInputSchema, searchCatalogInputSchema } from "../../src/api-tools/api-tools";

// 仅解析模型工具的输入载荷，测试数据不触发目录访问或查询执行。
describe("API 工具合同", () => {
  it("接受目录搜索输入并补齐 limit", () => {
    const result = searchCatalogInputSchema.parse({ source_id: "clinical", query: "门诊 人次" });

    expect(result.limit).toBe(20);
  });

  it("接受结构化查询输入", () => {
    expect(
      queryDatasetInputSchema.safeParse({
        query: {
          type: "relational_query",
          source_id: "clinical",
          from: { object_id: "clinical.visit", alias: "visit" },
          select: [{ field: "visit.id", aggregation: "count" }],
        },
      }).success,
    ).toBe(true);
  });

  it("拒绝自由 SQL 字段", () => {
    expect(queryDatasetInputSchema.safeParse({ query: { sql: "select 1" } }).success).toBe(false);
  });
});
