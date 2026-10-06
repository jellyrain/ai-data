import { describe, expect, it } from "vitest";
import {
  knowledgeOwnerOptionsInputSchema,
  preferenceEditStateSchema,
  rollbackKnowledgeSchema,
  updateKnowledgeSchema,
} from "../../src/index";

describe("知识管理与个人偏好编辑合同", () => {
  it("负责人搜索有明确数量边界，并拒绝客户端指定组织", () => {
    expect(knowledgeOwnerOptionsInputSchema.parse({})).toEqual({ keyword: "", limit: 50 });
    expect(knowledgeOwnerOptionsInputSchema.parse({ keyword: "张", limit: "20" }).limit).toBe(20);
    for (const input of [{ limit: 201 }, { limit: 0 }, { organization_id: "other" }])
      expect(knowledgeOwnerOptionsInputSchema.safeParse(input).success).toBe(false);
  });
  it("删除状态只携带版本基准，创建基准必须为零", () => {
    expect(preferenceEditStateSchema.parse({ status: "deleted", version: 2 })).toEqual({
      status: "deleted",
      version: 2,
    });
    expect(preferenceEditStateSchema.safeParse({ status: "missing", version: 2 }).success).toBe(
      false,
    );
    expect(
      preferenceEditStateSchema.safeParse({ status: "deleted", version: 2, value: "old" }).success,
    ).toBe(false);
    expect(preferenceEditStateSchema.safeParse({ status: "live", version: 1 }).success).toBe(false);
  });
  it("修改和回滚绑定正版本，回滚校验真实日期及幂等键", () => {
    expect(
      updateKnowledgeSchema.safeParse({
        expected_version: 1,
        content: { type: "business_rule", title: "日期", body: "按入院日" },
        scope: {},
      }).success,
    ).toBe(true);
    const input = {
      version: 1,
      expected_version: 2,
      effective_at: "2026-10-03 10:00:00",
      idempotency_key: "rollback",
    };
    expect(rollbackKnowledgeSchema.safeParse(input).success).toBe(true);
    for (const change of [
      { version: 0 },
      { effective_at: "2026-02-30 10:00:00" },
      { idempotency_key: "" },
      { extra: true },
    ])
      expect(rollbackKnowledgeSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
