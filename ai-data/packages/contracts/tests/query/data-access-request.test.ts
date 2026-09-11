import { describe, expect, it } from "vitest";

import { dataAccessQueryRequestSchema } from "../../src/query/data-access-request";

describe("Data Access Service 查询请求合同", () => {
  const base = {
    access: {
      user_id: "user-001",
      organization_id: "org-001",
      analysis_run_id: "run-001",
      policy_version: 1,
      expires_at: "2026-08-26 12:00:00",
      output_masks: [
        {
          result_column: "patient_phone",
          rule: { type: "partial_mask", prefix_length: 3, suffix_length: 4, mask_character: "*" },
        },
      ],
    },
    query: {
      type: "relational_query" as const,
      source_id: "clinical",
      from: { object_id: "clinical.visit", alias: "v" },
      select: [{ field: "v.id" }],
    },
  };

  it("接受 API 已签名的 access、query 和整体签名", () => {
    const result = dataAccessQueryRequestSchema.parse({ ...base, signature: "sig-v1-abc" });

    expect(result.query.source_id).toBe("clinical");
    expect(result.signature).toBe("sig-v1-abc");
  });

  it("拒绝缺少整体签名或携带未知字段", () => {
    expect(dataAccessQueryRequestSchema.safeParse(base).success).toBe(false);
    expect(
      dataAccessQueryRequestSchema.safeParse({ ...base, signature: "sig", extra: true }).success,
    ).toBe(false);
  });
});
