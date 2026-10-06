import { describe, expect, it } from "vitest";
import {
  conversationSchema,
  conversationDetailSchema,
  submittedMessageSchema,
} from "../../../src/features/analysis/api/analysis-schema";

const legacyConversation = {
  id: "c",
  organizationId: "o",
  userId: "u",
  title: null,
  status: "active",
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};
const conversation = { ...legacyConversation, agentId: "clinical", agentVersion: 1 };
const message = {
  id: "m",
  conversationId: "c",
  role: "user",
  content: "门诊人次",
  sequence: 1,
  createdAt: "2026-09-27T00:00:00.000Z",
};

describe("会话接口接收合同", () => {
  it("接收 camelCase、ISO 时间和固定 Agent 版本，兼容旧会话省略绑定", () => {
    expect(conversationSchema.parse(conversation)).toEqual(conversation);
    expect(conversationSchema.parse(legacyConversation)).toEqual(legacyConversation);
  });

  it.each([
    { ...conversation, id: "" },
    { ...conversation, status: "deleted" },
    { ...conversation, createdAt: "2026-02-30" },
    { ...conversation, agentVersion: 0 },
    { ...conversation, agentVersion: undefined },
    { ...conversation, unknown: true },
  ])("无效会话必须在 HTTP 接收边界拒绝：%j", (input) => {
    expect(conversationSchema.safeParse(input).success).toBe(false);
  });

  it("消息缺少运行标识仍可读取，但不能接收其他会话的消息", () => {
    expect(
      conversationDetailSchema.parse({ conversation, messages: [message] }).messages[0]
        .analysisRunId,
    ).toBeUndefined();
    expect(
      conversationDetailSchema.safeParse({
        conversation,
        messages: [{ ...message, conversationId: "other" }],
      }).success,
    ).toBe(false);
    expect(
      conversationDetailSchema.safeParse({
        conversation,
        messages: [{ ...message, role: "other" }],
      }).success,
    ).toBe(false);
  });

  it("提交回执从 analysisRun.id 关联运行，并拒绝回执中不一致的会话", () => {
    const analysisRun = {
      id: "r",
      conversationId: "c",
      organizationId: "o",
      userId: "u",
      status: "created",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-09-27T00:00:00.000Z",
    };
    expect(submittedMessageSchema.parse({ message, analysisRun }).analysisRun.id).toBe("r");
    expect(
      submittedMessageSchema.safeParse({
        message,
        analysisRun: { ...analysisRun, conversationId: "other" },
      }).success,
    ).toBe(false);
  });
});
