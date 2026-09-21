import { describe, expect, it } from "vitest";

import type {
  AnalysisRun,
  Conversation,
  ConversationMessage,
  ConversationRepository,
} from "../../src/conversations/conversation-types";
import { ConversationService } from "../../src/conversations/conversation-service";

/** 内存仓储模拟会话归属过滤，保留消息与运行供断言其关联关系。 */
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
  async submitMessage(
    conversationId: string,
    userId: string,
    organizationId: string,
    content: string,
  ) {
    if (!(await this.findConversation(conversationId, userId, organizationId))) return null;
    const now = new Date();
    const message: ConversationMessage = {
      id: "message",
      conversationId,
      role: "user",
      content,
      sequence: this.messages.length,
      createdAt: now,
    };
    const analysisRun: AnalysisRun = {
      id: "run",
      conversationId,
      userId,
      organizationId,
      status: "created",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    };
    this.messages.push(message);
    this.runs.push(analysisRun);
    return { message, analysisRun };
  }
}

describe("会话服务", () => {
  it("创建会话时固定选择的 Agent 版本，配置后续变化不会改写会话", async () => {
    const repository = new MemoryConversationRepository();
    const context = {
      userId: "user",
      organizationId: "org",
      sessionId: "session",
      roles: [],
      permissions: [],
      dataPolicies: [],
    };
    const service = new ConversationService(repository, {
      authorizeRun: async () => {},
      selectAgent: async (_context, id, version) => ({
        agentId: id ?? "default",
        agentVersion: version ?? 1,
      }),
    });
    const conversation = await service.create(context, "测试", {
      agent_id: "outpatient",
      agent_version: 2,
    });
    expect(conversation).toMatchObject({ agentId: "outpatient", agentVersion: 2 });
    expect((await service.get(context, conversation.id))?.conversation.agentVersion).toBe(2);
  });
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
    const submitted = await service.submitUserMessage(
      context,
      conversation.id,
      "统计门诊量",
      "request-1",
    );

    expect(submitted?.message.conversationId).toBe(conversation.id);
    expect(submitted?.analysisRun.conversationId).toBe(conversation.id);
    expect(repository.runs[0]?.status).toBe("created");
  });

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
