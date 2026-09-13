import type { AuthContext } from "../auth/auth-types";
import type {
  AnalysisRun,
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationRepository,
  SubmittedMessage,
} from "./conversation-types";

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

  /** 校验会话归属及 active 状态后，依次保存用户消息与待执行分析运行。 */
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
    // 消息和运行分别写入仓储；序号取当前消息数，串行推进由上层运行流程协调。
    await this.repository.appendMessage(message);
    await this.repository.createAnalysisRun(analysisRun);
    return { message, analysisRun };
  }
}

export { ConversationService };
