import { describe, expect, it } from "vitest";
import { reportListInputSchema, reportSharingInputSchema } from "../../src/index";

describe("报表管理请求边界", () => {
  it("默认分页20且最多100条，未知字段和空游标拒绝", () => {
    expect(reportListInputSchema.parse({}).limit).toBe(20);
    expect(reportListInputSchema.parse({ limit: "100", cursor: "report" }).limit).toBe(100);
    for (const input of [{ limit: 101 }, { cursor: "" }, { unknown: true }])
      expect(reportListInputSchema.safeParse(input).success).toBe(false);
  });
  it("分享提交必须有正版本和明确账号列表", () => {
    expect(reportSharingInputSchema.parse({ expected_version: 2, shared_with: [] })).toEqual({
      expected_version: 2,
      shared_with: [],
    });
    for (const input of [
      { shared_with: [] },
      { expected_version: 0, shared_with: [] },
      { expected_version: 1, shared_with: [""] },
      { expected_version: 1, shared_with: [], access: "public" },
    ])
      expect(reportSharingInputSchema.safeParse(input).success).toBe(false);
  });
});
