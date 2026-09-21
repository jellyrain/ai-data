import { describe, expect, it } from "vitest";
import {
  knowledgeCandidateInputSchema,
  knowledgeContentSchema,
  knowledgeReviewInputSchema,
  knowledgePublishInputSchema,
  memoryIntentSchema,
  memoryEventSummarySchema,
  memoryContextSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceInputSchema,
} from "../../src/index";

describe("记忆与知识边界合同", () => {
  const rule = { type: "business_rule", title: "收入口径", body: "按已记账收入统计" };
  const candidate = {
    idempotency_key: "submit",
    content: rule,
    scope: { source_id: "sales", object_id: "orders" },
  };
  it("候选来源及引用范围合法，缺少业务正文或对象缺少数据源时拒绝", () => {
    expect(knowledgeCandidateInputSchema.parse(candidate).content).toEqual(rule);
    expect(
      knowledgeCandidateInputSchema.safeParse({
        ...candidate,
        content: { type: "business_rule", title: "x" },
      }).success,
    ).toBe(false);
    expect(
      knowledgeCandidateInputSchema.safeParse({ ...candidate, scope: { object_id: "orders" } })
        .success,
    ).toBe(false);
    expect(knowledgeContentSchema.safeParse({ ...rule, body: "a".repeat(16001) }).success).toBe(
      false,
    );
  });
  it("审核与发布需要明确版本、理由和真实生效时间，不能提前自定状态", () => {
    expect(
      knowledgeReviewInputSchema.parse({
        expected_version: 1,
        decision: "approve",
        comment: "已核对",
      }).decision,
    ).toBe("approve");
    for (const input of [
      { expected_version: 0, decision: "approve", comment: "理由" },
      { expected_version: 1, decision: "publish", comment: "理由" },
      { expected_version: 1, decision: "approve" },
      { expected_version: 1, decision: "approve", comment: "理由", status: "approved" },
    ])
      expect(knowledgeReviewInputSchema.safeParse(input).success).toBe(false);
    expect(
      knowledgePublishInputSchema.safeParse({
        expected_version: 1,
        effective_at: "2026-02-30 12:00:00",
      }).success,
    ).toBe(false);
    expect(
      knowledgePublishInputSchema.parse({
        expected_version: 1,
        effective_at: "2026-09-20 12:00:00",
      }).expected_version,
    ).toBe(1);
  });
  it("后台只接受已声明的结构化意图，管理状态不接受正文或未知状态", () => {
    expect(memoryIntentSchema.parse({ type: "knowledge_candidate", candidate }).type).toBe(
      "knowledge_candidate",
    );
    expect(
      memoryIntentSchema.safeParse({ type: "execute_instruction", prompt: "do something" }).success,
    ).toBe(false);
    const summary = {
      event_id: "e",
      analysis_run_id: "r",
      status: "pending",
      attempts: 0,
      created_at: "2026-09-20 12:00:00",
      updated_at: "2026-09-20 12:00:00",
      last_error_code: null,
    };
    expect(memoryEventSummarySchema.parse(summary).attempts).toBe(0);
    for (const bad of [
      { ...summary, status: "cancelled" },
      { ...summary, attempts: -1 },
      { ...summary, intent_json: "private" },
    ])
      expect(memoryEventSummarySchema.safeParse(bad).success).toBe(false);
  });
  it("确认归属和版本必填，客户端不能把确认字段混入普通保存", () => {
    expect(preferenceConfirmationSchema.safeParse({ status: "accepted" }).success).toBe(false);
    const input = {
      key: "style",
      value: { type: "presentation", format: "table" },
      idempotency_key: "save",
    };
    expect(saveUserPreferenceInputSchema.parse(input).auto_apply).toBe(true);
    expect(saveUserPreferenceInputSchema.safeParse({ ...input, confirmed: true }).success).toBe(
      false,
    );
    expect(
      saveUserPreferenceInputSchema.safeParse({ ...input, expected_version: -1 }).success,
    ).toBe(false);
  });
  it("单轮上下文容量受限且拒绝附带执行指令字段", () => {
    const context = {
      rules: "当前条件优先",
      preferences: [],
      knowledge: [],
      pending_confirmations: [],
      disabled_keys: [],
    };
    expect(memoryContextSchema.parse(context)).toEqual(context);
    expect(memoryContextSchema.safeParse({ ...context, execute: "arbitrary" }).success).toBe(false);
    expect(
      memoryContextSchema.safeParse({
        ...context,
        disabled_keys: Array.from({ length: 201 }, () => "key"),
      }).success,
    ).toBe(false);
  });
});
