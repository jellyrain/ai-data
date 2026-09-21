import dayjs from "dayjs";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { createHash, randomUUID } from "node:crypto";
import { submitMessageSchema } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";
import { insertAnalysisRun, readAnalysisRun } from "../analysis-runs/analysis-run-records";
import type { AnalysisRun } from "../analysis-runs/analysis-run-record-types";

import type {
  Conversation,
  ConversationMessage,
  ConversationRepository,
  SubmittedMessage,
} from "./conversation-types";

/** API 对话会话、消息和分析运行的参数化 SQL Server 仓储。 */
class SqlConversationRepository implements ConversationRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  /** 会话行锁统一保护重复提交、消息序号和活跃运行检查。 */
  async submitMessage(
    conversationId: string,
    userId: string,
    organizationId: string,
    content: string,
    idempotencyKey: string,
    sessionId?: string,
  ): Promise<SubmittedMessage | null> {
    const input = submitMessageSchema.parse({ content, idempotency_key: idempotencyKey });
    const hash = createHash("sha256").update(input.content).digest("hex");
    return this.database.transaction(async (executor) => {
      const conversation = await executor.execute({
        sql: "SELECT id FROM dbo.conversations WITH (UPDLOCK,HOLDLOCK) WHERE id=@id AND user_id=@user AND organization_id=@org AND status='active'",
        parameters: [
          { name: "id", type: "string", value: conversationId },
          { name: "user", type: "string", value: userId },
          { name: "org", type: "string", value: organizationId },
        ],
      });
      if (!conversation.rows[0]) return null;
      const prior = await executor.execute({
        sql: "SELECT request_hash, message_id, analysis_run_id FROM dbo.conversation_submissions WHERE conversation_id=@conversation AND idempotency_key=@key",
        parameters: [
          { name: "conversation", type: "string", value: conversationId },
          { name: "key", type: "string", value: idempotencyKey },
        ],
      });
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash)
          throw new ApplicationError("CONFLICT", "幂等键已用于其他问题");
        const message = await executor.execute<ConversationMessageRow>({
          sql: "SELECT id, conversation_id, role, content, sequence, created_at FROM dbo.conversation_messages WHERE id=@id",
          parameters: [{ name: "id", type: "string", value: String(prior.rows[0].message_id) }],
        });
        return {
          message: this.mapMessage(message.rows[0]),
          analysisRun: await readAnalysisRun(executor, String(prior.rows[0].analysis_run_id)),
        };
      }
      const active = await executor.execute({
        sql: "SELECT TOP (1) id FROM dbo.analysis_runs WHERE conversation_id=@id AND status IN ('created','running','waiting_clarification','cancelling')",
        parameters: [{ name: "id", type: "string", value: conversationId }],
      });
      if (active.rows[0])
        throw new ApplicationError("CONFLICT", "会话已有活跃运行，请完成或取消后再提交");
      const sequence = await executor.execute({
        sql: "SELECT COALESCE(MAX(sequence),-1)+1 AS sequence FROM dbo.conversation_messages WHERE conversation_id=@id",
        parameters: [{ name: "id", type: "string", value: conversationId }],
      });
      const now = dayjs().toDate();
      const message: ConversationMessage = {
        id: randomUUID(),
        conversationId,
        role: "user",
        content: input.content,
        sequence: Number(sequence.rows[0].sequence),
        createdAt: now,
      };
      const analysisRun: AnalysisRun = {
        id: randomUUID(),
        conversationId,
        organizationId,
        userId,
        status: "created",
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
      };
      await this.appendMessage(message, executor);
      await insertAnalysisRun(executor, analysisRun);
      await executor.execute({
        sql: "UPDATE r SET agent_id=c.agent_id,agent_version=c.agent_version FROM dbo.analysis_runs r JOIN dbo.conversations c ON c.id=r.conversation_id WHERE r.id=@run",
        parameters: [{ name: "run", type: "string", value: analysisRun.id }],
      });
      await executor.execute({
        sql: "UPDATE dbo.conversation_messages SET analysis_run_id=@run WHERE id=@message",
        parameters: [
          { name: "run", type: "string", value: analysisRun.id },
          { name: "message", type: "string", value: message.id },
        ],
      });
      if (sessionId)
        await executor.execute({
          sql: "INSERT INTO dbo.analysis_dispatches(analysis_run_id,session_id) VALUES(@run,@session)",
          parameters: [
            { name: "run", type: "string", value: analysisRun.id },
            { name: "session", type: "string", value: sessionId },
          ],
        });
      await executor.execute({
        sql: "INSERT INTO dbo.conversation_submissions (conversation_id,idempotency_key,request_hash,message_id,analysis_run_id) VALUES (@conversation,@key,@hash,@message,@run); UPDATE dbo.conversations SET updated_at=SYSUTCDATETIME() WHERE id=@conversation;",
        parameters: [
          { name: "conversation", type: "string", value: conversationId },
          { name: "key", type: "string", value: idempotencyKey },
          { name: "hash", type: "string", value: hash },
          { name: "message", type: "string", value: message.id },
          { name: "run", type: "string", value: analysisRun.id },
        ],
      });
      return { message, analysisRun };
    });
  }

  /** 保存会话并绑定当前组织和用户。 */
  async createConversation(conversation: Conversation): Promise<void> {
    await this.database.execute({
      sql: "INSERT INTO dbo.conversations (id, organization_id, user_id, title, status, created_at, updated_at, agent_id, agent_version) VALUES (@id, @organization_id, @user_id, @title, @status, @created_at, @updated_at, @agent, @version)",
      parameters: [
        { name: "id", type: "string", value: conversation.id },
        { name: "organization_id", type: "string", value: conversation.organizationId },
        { name: "user_id", type: "string", value: conversation.userId },
        { name: "title", type: "string", value: conversation.title },
        { name: "status", type: "string", value: conversation.status },
        { name: "created_at", type: "date", value: conversation.createdAt },
        { name: "updated_at", type: "date", value: conversation.updatedAt },
        { name: "agent", type: "string", value: conversation.agentId ?? null },
        { name: "version", type: "integer", value: conversation.agentVersion ?? null },
      ],
    });
  }

  /** 按组织和用户读取会话，避免跨用户访问。 */
  async findConversation(
    conversationId: string,
    userId: string,
    organizationId: string,
  ): Promise<Conversation | null> {
    const result = await this.database.execute<ConversationRow>({
      sql: "SELECT id, organization_id, user_id, title, status, created_at, updated_at, agent_id, agent_version FROM dbo.conversations WHERE id = @id AND user_id = @user_id AND organization_id = @organization_id",
      parameters: [
        { name: "id", type: "string", value: conversationId },
        { name: "user_id", type: "string", value: userId },
        { name: "organization_id", type: "string", value: organizationId },
      ],
    });
    return result.rows[0] ? this.mapConversation(result.rows[0]) : null;
  }

  /** 按用户与组织过滤会话，并按最后更新时间倒序返回。 */
  async listConversations(userId: string, organizationId: string): Promise<Conversation[]> {
    const result = await this.database.execute<ConversationRow>({
      sql: "SELECT id, organization_id, user_id, title, status, created_at, updated_at, agent_id, agent_version FROM dbo.conversations WHERE user_id = @user_id AND organization_id = @organization_id ORDER BY updated_at DESC",
      parameters: [
        { name: "user_id", type: "string", value: userId },
        { name: "organization_id", type: "string", value: organizationId },
      ],
    });
    return result.rows.map((row) => this.mapConversation(row));
  }

  /** 保存调用方提供的序号；数据库唯一约束防止同一会话出现重复序号。 */
  private async appendMessage(
    message: ConversationMessage,
    executor: MetadataQueryExecutor,
  ): Promise<void> {
    await executor.execute({
      sql: "INSERT INTO dbo.conversation_messages (id, conversation_id, role, content, sequence, created_at) VALUES (@id, @conversation_id, @role, @content, @sequence, @created_at)",
      parameters: [
        { name: "id", type: "string", value: message.id },
        { name: "conversation_id", type: "string", value: message.conversationId },
        { name: "role", type: "string", value: message.role },
        { name: "content", type: "string", value: message.content },
        { name: "sequence", type: "integer", value: message.sequence },
        { name: "created_at", type: "date", value: message.createdAt },
      ],
    });
  }

  /** 按序号读取消息；调用方应先通过会话查询完成用户与组织归属检查。 */
  async listMessages(conversationId: string): Promise<ConversationMessage[]> {
    const result = await this.database.execute<ConversationMessageRow>({
      sql: "SELECT id, conversation_id, role, content, sequence, created_at, analysis_run_id FROM dbo.conversation_messages WHERE conversation_id = @conversation_id ORDER BY sequence",
      parameters: [{ name: "conversation_id", type: "string", value: conversationId }],
    });
    return result.rows.map((row) => this.mapMessage(row));
  }

  /** 将数据库会话行转换为会话领域对象。 */
  private mapConversation(row: ConversationRow): Conversation {
    return {
      id: row.id,
      organizationId: row.organization_id,
      userId: row.user_id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.agent_id ? { agentId: row.agent_id, agentVersion: row.agent_version! } : {}),
    };
  }
  /** 将数据库消息行转换为会话消息领域对象。 */
  private mapMessage(row: ConversationMessageRow): ConversationMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      ...(row.analysis_run_id ? { analysisRunId: row.analysis_run_id } : {}),
      content: row.content,
      sequence: row.sequence,
      createdAt: row.created_at,
    };
  }
}

/** `conversations` 查询返回的数据库记录。 */
type ConversationRow = {
  /** 迁移前会话尚未选择 Agent，首次运行时固定版本。 */
  agent_id?: string | null;
  agent_version?: number | null;
  /** 会话主键。 */
  id: string;
  /** 会话所属组织主键。 */
  organization_id: string;
  /** 会话创建用户主键。 */
  user_id: string;
  /** 用户维护的会话标题。 */
  title: string | null;
  /** 数据库存储的会话状态。 */
  status: "active" | "archived";
  /** 数据库存储的创建时间。 */
  created_at: Date;
  /** 数据库存储的最后更新时间。 */
  updated_at: Date;
};

/** `conversation_messages` 查询返回的数据库记录。 */
type ConversationMessageRow = {
  /** 新消息持久化时记录对应运行；旧数据允许为空。 */
  analysis_run_id?: string | null;
  /** 消息主键。 */
  id: string;
  /** 消息所属会话主键。 */
  conversation_id: string;
  /** 消息来源角色。 */
  role: "user" | "assistant" | "system" | "tool";
  /** 消息正文。 */
  content: string;
  /** 会话内递增序号。 */
  sequence: number;
  /** 消息创建时间。 */
  created_at: Date;
};

export { SqlConversationRepository };
