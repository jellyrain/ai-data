import { describe, expect, it } from "vitest";
import {
  userPreferenceInputSchema,
  preferenceTimeRangeSchema,
} from "../../src/memory/user-preference";
import { knowledgeCandidateInputSchema } from "../../src/knowledge/knowledge";

describe("账号记忆与知识候选合同", () => {
  it("本年偏好保留相对语义并默认允许自动应用", () => {
    expect(
      userPreferenceInputSchema.parse({
        key: "sales-period",
        scope: { source_id: "sales", object_id: "orders" },
        value: {
          type: "time_range",
          range: { type: "relative", period: "this_year", extent: "to_date" },
        },
      }),
    ).toMatchObject({ auto_apply: true, value: { range: { period: "this_year" } } });
  });
  it("固定日期检查日历与顺序，相对时间拒绝额外字段", () => {
    expect(
      preferenceTimeRangeSchema.safeParse({ type: "fixed", start: "2026-02-30", end: "2026-03-01" })
        .success,
    ).toBe(false);
    expect(
      preferenceTimeRangeSchema.safeParse({ type: "fixed", start: "2026-03-02", end: "2026-03-01" })
        .success,
    ).toBe(false);
    expect(
      preferenceTimeRangeSchema.safeParse({
        type: "relative",
        period: "this_year",
        extent: "full_period",
        start: "2026-01-01",
      }).success,
    ).toBe(false);
  });
  it("偏好不接受客户端伪造确认，字段条件要求对象范围", () => {
    const input = {
      key: "groups",
      scope: {},
      value: { type: "grouping", fields: ["o.department"] },
    };
    expect(userPreferenceInputSchema.safeParse(input).success).toBe(false);
    expect(
      userPreferenceInputSchema.safeParse({
        ...input,
        scope: { source_id: "sales", object_id: "orders" },
        confirmed: true,
      }).success,
    ).toBe(false);
  });
  it("业务规则候选必须包含完整内容且不能自行提交审核状态", () => {
    const input = {
      idempotency_key: "submit-1",
      content: { type: "business_rule", title: "收入口径", body: "按结算时间统计" },
      scope: { source_id: "sales" },
    };
    expect(knowledgeCandidateInputSchema.safeParse(input).success).toBe(true);
    expect(knowledgeCandidateInputSchema.safeParse({ ...input, status: "published" }).success).toBe(
      false,
    );
    expect(
      knowledgeCandidateInputSchema.safeParse({
        ...input,
        content: { type: "business_rule", title: "", body: "" },
      }).success,
    ).toBe(false);
  });
});
