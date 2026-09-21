import dayjs from "dayjs";
import type { CreateConversation } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";
import type { AnalysisDispatcher } from "../runtime/runtime-types";
import type { AuthContext } from "../auth/auth-types";
import type {
  Conversation,
  ConversationDetail,
  ConversationRepository,
  SubmittedMessage,
} from "./conversation-types";

/** 使用当前可信身份上下文维护会话、用户消息和分析运行。 */
class ConversationService {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly runtime?: {
      dispatcher?: Pick<AnalysisDispatcher, "wake">;
      authorizeRun: (context: AuthContext, runId: string) => Promise<unknown>;
      selectAgent?: (
        context: AuthContext,
        agentId?: string,
        version?: number,
      ) => Promise<{ agentId: string; agentVersion: number } | undefined>;
    },
  ) {}

  /** 创建当前用户所属组织的新会话。 */
  async create(
    context: AuthContext,
    title?: string,
    selection?: Pick<CreateConversation, "agent_id" | "agent_version">,
  ): Promise<Conversation> {
    if (selection?.agent_id && !this.runtime?.selectAgent)
      throw new ApplicationError("INVALID_INPUT", "当前服务未配置 Agent");
    const agent = await this.runtime?.selectAgent?.(
      context,
      selection?.agent_id,
      selection?.agent_version,
    );
    const now = dayjs().toDate();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      organizationId: context.organizationId,
      userId: context.userId,
      title: title ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      ...agent,
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
    const messages = await this.repository.listMessages(conversation.id);
    for (const runId of new Set(
      messages.flatMap((message) => (message.analysisRunId ? [message.analysisRunId] : [])),
    ))
      await this.runtime?.authorizeRun(context, runId);
    return { conversation, messages };
  }

  /** 归属校验、幂等检查和原子写入由仓储在同一事务内完成。 */
  async submitUserMessage(
    context: AuthContext,
    conversationId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<SubmittedMessage | null> {
    const submitted = await this.repository.submitMessage(
      conversationId,
      context.userId,
      context.organizationId,
      content,
      idempotencyKey,
      ...(this.runtime?.dispatcher ? [context.sessionId] : []),
    );
    if (submitted) this.runtime?.dispatcher?.wake();
    return submitted;
  }
}

export { ConversationService };
