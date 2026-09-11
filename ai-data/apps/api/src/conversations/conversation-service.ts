import type {
  AnalysisRun,
  AuthContext,
  Conversation,
  ConversationMessage,
  ConversationRepository,
} from "../auth/auth-types";

/** 会话详情及其按序排列的消息。 */
type ConversationDetail = {
  /** 当前身份可访问的会话。 */
  conversation: Conversation;
  /** 会话内全部已持久化消息。 */
  messages: ConversationMessage[];
};

/** 用户消息持久化后创建分析运行的结果。 */
type SubmittedMessage = {
  /** 已追加到会话的用户消息。 */
  message: ConversationMessage;
  /** 供 Harness 后续执行的分析运行。 */
  analysisRun: AnalysisRun;
};

/** 使用当前可信身份上下文维护会话、用户消息和分析运行。 */
class ConversationService {
  constructor(private readonly repository: ConversationRepository) {}

  /** 创建当前用户所属组织的新会话。 */
  async create(context: AuthContext, title?: string): Promise<Conversation> {
    const now = new Date();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      organizationId: context.organizationId,
      userId: context.userId,
      title: title ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createConversation(conversation);
    return conversation;
  }

  /** 返回当前用户有权访问的会话列表。 */
  async list(context: AuthContext): Promise<Conversation[]> {
    return this.repository.listConversations(context.userId, context.organizationId);
  }

  /** 返回会话及其按序消息；跨用户和跨组织时不暴露记录。 */
  async get(context: AuthContext, conversationId: string): Promise<ConversationDetail | null> {
    const conversation = await this.repository.findConversation(
      conversationId,
      context.userId,
      context.organizationId,
    );
    if (!conversation) return null;
    return { conversation, messages: await this.repository.listMessages(conversation.id) };
  }

  /** 追加用户消息，并创建供后续 Harness 执行的分析运行。 */
  async submitUserMessage(
    context: AuthContext,
    conversationId: string,
    content: string,
  ): Promise<SubmittedMessage | null> {
    const detail = await this.get(context, conversationId);
    if (!detail || detail.conversation.status !== "active") return null;
    const now = new Date();
    const message: ConversationMessage = {
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content,
      sequence: detail.messages.length,
      createdAt: now,
    };
    const analysisRun: AnalysisRun = {
      id: crypto.randomUUID(),
      conversationId,
      organizationId: context.organizationId,
      userId: context.userId,
      status: "created",
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    };
    await this.repository.appendMessage(message);
    await this.repository.createAnalysisRun(analysisRun);
    return { message, analysisRun };
  }
}

export { ConversationService };
export type { ConversationDetail, SubmittedMessage };
