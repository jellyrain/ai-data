import { describe, expect, it } from "vitest";

import { queryDatasetInputSchema, searchCatalogInputSchema } from "../../src/api-tools/api-tools";

describe("API 工具合同", () => {
  // BDD 场景：Agent 用关键词搜索当前数据目录；TDD 断言：工具输入接受并补齐默认分页。
  it("接受目录搜索输入并补齐 limit", () => {
    const result = searchCatalogInputSchema.parse({ source_id: "clinical", query: "门诊 人次" });

    expect(result.limit).toBe(20);
  });

  // BDD 场景：模型请求执行关系 DSL；TDD 断言：API 查询工具只接受结构化 DSL。
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

  // BDD 场景：调用方试图把自由 SQL 传给查询工具；TDD 断言：未知字段必须拒绝。
  it("拒绝自由 SQL 字段", () => {
    expect(queryDatasetInputSchema.safeParse({ query: { sql: "select 1" } }).success).toBe(false);
  });
});
