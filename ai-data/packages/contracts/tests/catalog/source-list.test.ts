import { describe, expect, it } from "vitest";
import { sourceListInputSchema, sourceListSchema } from "../../src/catalog/source-list";

describe("当前可用数据源列表合同", () => {
  it("默认每页20项，接受有界游标和空结果", () => {
    expect(sourceListInputSchema.parse({})).toEqual({ limit: 20 });
    expect(sourceListInputSchema.parse({ limit: "100", cursor: "clinical" }).limit).toBe(100);
    expect(sourceListSchema.parse({ items: [] })).toEqual({ items: [] });
  });
  it("拒绝未知身份字段、超限分页及内部连接信息", () => {
    for (const input of [{ limit: 101 }, { limit: 0 }, { cursor: "" }, { user_id: "other" }])
      expect(sourceListInputSchema.safeParse(input).success).toBe(false);
    expect(
      sourceListSchema.safeParse({ items: [{ source_id: "s", serviceUrl: "private" }] }).success,
    ).toBe(false);
  });
});
