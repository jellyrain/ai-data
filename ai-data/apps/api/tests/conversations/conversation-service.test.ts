import { describe, expect, it } from "vitest";

import type {
  AnalysisRun,
  Conversation,
  ConversationMessage,
  ConversationRepository,
} from "../../src/auth/auth-types";
import { ConversationService } from "../../src/conversations/conversation-service";

class MemoryConversationRepository implements ConversationRepository {
  conversations: Conversation[] = [];
  messages: ConversationMessage[] = [];
  runs: AnalysisRun[] = [];
  createConversation(conversation: Conversation) {
    this.conversations.push(conversation);
    return Promise.resolve();
  }
  findConversation(id: string, userId: string, organizationId: string) {
    return Promise.resolve(
      this.conversations.find(
        (item) =>
          item.id === id && item.userId === userId && item.organizationId === organizationId,
      ) ?? null,
    );
  }
  listConversations(userId: string, organizationId: string) {
    return Promise.resolve(
      this.conversations.filter(
        (item) => item.userId === userId && item.organizationId === organizationId,
      ),
    );
  }
  appendMessage(message: ConversationMessage) {
    this.messages.push(message);
    return Promise.resolve();
  }
  listMessages(conversationId: string) {
    return Promise.resolve(this.messages.filter((item) => item.conversationId === conversationId));
  }
  createAnalysisRun(run: AnalysisRun) {
    this.runs.push(run);
    return Promise.resolve();
  }
  updateAnalysisRun() {
    return Promise.resolve(false);
  }
}

describe("会话服务", () => {
  // BDD 场景：已登录用户发起一个问题；TDD 断言：消息与待执行分析运行关联到同一可信会话。
  it("创建会话并提交用户消息", async () => {
    const repository = new MemoryConversationRepository();
    const service = new ConversationService(repository);
    const context = {
      userId: "user-001",
      organizationId: "organization-001",
      sessionId: "session-001",
      roles: [],
      permissions: [],
      dataPolicies: [],
    };
    const conversation = await service.create(context, "门诊分析");
    const submitted = await service.submitUserMessage(context, conversation.id, "统计门诊量");

    expect(submitted?.message.conversationId).toBe(conversation.id);
    expect(submitted?.analysisRun.conversationId).toBe(conversation.id);
    expect(repository.runs[0]?.status).toBe("created");
  });

  // BDD 场景：另一用户猜测会话标识；TDD 断言：服务不返回其他用户的会话。
  it("隔离其他用户的会话", async () => {
    const repository = new MemoryConversationRepository();
    const service = new ConversationService(repository);
    const owner = {
      userId: "user-001",
      organizationId: "organization-001",
      sessionId: "session-001",
      roles: [],
      permissions: [],
      dataPolicies: [],
    };
    const visitor = { ...owner, userId: "user-002" };
    const conversation = await service.create(owner);

    await expect(service.get(visitor, conversation.id)).resolves.toBeNull();
  });
});
