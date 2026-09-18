import { describe, expect, it } from "vitest";
import { queryDslSchema, queryResultSchema } from "../../src/index";

describe("明细结果交付合同", () => {
  const query = {
    type: "relational_query",
    source_id: "s",
    from: { object_id: "visits", alias: "v" },
    select: [{ field: "v.id" }],
  };
  const result = {
    columns: [{ name: "id", data_type: "integer" }],
    rows: [{ id: 1 }],
    row_count: 1,
    truncated: false,
  };

  it("允许五万行明细，并拒绝超过十万行的请求", () => {
    expect(queryDslSchema.safeParse({ ...query, limit: 50000 }).success).toBe(true);
    expect(queryDslSchema.safeParse({ ...query, limit: 100001 }).success).toBe(false);
  });

  it("完整结果声明准确总数，截断结果总数保持未知", () => {
    expect(
      queryResultSchema.safeParse({
        ...result,
        delivery: { status: "complete", total_row_count: 1 },
      }).success,
    ).toBe(true);
    expect(
      queryResultSchema.safeParse({
        ...result,
        truncated: true,
        delivery: { status: "truncated", total_row_count: null },
      }).success,
    ).toBe(true);
  });

  it.each([
    { status: "complete", total_row_count: 2 },
    { status: "truncated", total_row_count: null },
    { status: "complete", total_row_count: null },
  ])("拒绝不符合返回行数或截断状态的交付声明 %#", (delivery) => {
    expect(queryResultSchema.safeParse({ ...result, delivery }).success).toBe(false);
  });
});
