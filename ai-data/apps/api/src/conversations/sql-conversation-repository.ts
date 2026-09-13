import type { MetadataQueryExecutor } from "@ai-data/metadata";

import type {
  AnalysisRun,
  AnalysisRunStatus,
  Conversation,
  ConversationMessage,
  ConversationRepository,
} from "./conversation-types";

/** API 对话会话、消息和分析运行的参数化 SQL Server 仓储。 */
class SqlConversationRepository implements ConversationRepository {
  constructor(private readonly database: MetadataQueryExecutor) {}

  /** 保存会话并绑定当前组织和用户。 */
  async createConversation(conversation: Conversation): Promise<void> {
    await this.database.execute({
      sql: "INSERT INTO dbo.conversations (id, organization_id, user_id, title, status, created_at, updated_at) VALUES (@id, @organization_id, @user_id, @title, @status, @created_at, @updated_at)",
      parameters: [
        { name: "id", type: "string", value: conversation.id },
        { name: "organization_id", type: "string", value: conversation.organizationId },
        { name: "user_id", type: "string", value: conversation.userId },
        { name: "title", type: "string", value: conversation.title },
        { name: "status", type: "string", value: conversation.status },
        { name: "created_at", type: "date", value: conversation.createdAt },
        { name: "updated_at", type: "date", value: conversation.updatedAt },
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
      sql: "SELECT id, organization_id, user_id, title, status, created_at, updated_at FROM dbo.conversations WHERE id = @id AND user_id = @user_id AND organization_id = @organization_id",
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
      sql: "SELECT id, organization_id, user_id, title, status, created_at, updated_at FROM dbo.conversations WHERE user_id = @user_id AND organization_id = @organization_id ORDER BY updated_at DESC",
      parameters: [
        { name: "user_id", type: "string", value: userId },
        { name: "organization_id", type: "string", value: organizationId },
      ],
    });
    return result.rows.map((row) => this.mapConversation(row));
  }

  /** 保存调用方提供的序号；数据库唯一约束防止同一会话出现重复序号。 */
  async appendMessage(message: ConversationMessage): Promise<void> {
    await this.database.execute({
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
      sql: "SELECT id, conversation_id, role, content, sequence, created_at FROM dbo.conversation_messages WHERE conversation_id = @conversation_id ORDER BY sequence",
      parameters: [{ name: "conversation_id", type: "string", value: conversationId }],
    });
    return result.rows.map((row) => this.mapMessage(row));
  }

  /** 保存一次分析运行。 */
  async createAnalysisRun(run: AnalysisRun): Promise<void> {
    await this.database.execute({
      sql: "INSERT INTO dbo.analysis_runs (id, conversation_id, organization_id, user_id, status, error_code, error_message, started_at, completed_at, created_at) VALUES (@id, @conversation_id, @organization_id, @user_id, @status, @error_code, @error_message, @started_at, @completed_at, @created_at)",
      parameters: [
        { name: "id", type: "string", value: run.id },
        { name: "conversation_id", type: "string", value: run.conversationId },
        { name: "organization_id", type: "string", value: run.organizationId },
        { name: "user_id", type: "string", value: run.userId },
        { name: "status", type: "string", value: run.status },
        { name: "error_code", type: "string", value: run.errorCode },
        { name: "error_message", type: "string", value: run.errorMessage },
        { name: "started_at", type: "date", value: run.startedAt },
        { name: "completed_at", type: "date", value: run.completedAt },
        { name: "created_at", type: "date", value: run.createdAt },
      ],
    });
  }

  /** 按用户与组织更新运行状态及时间；当前 SQL 以归属条件定位记录。 */
  async updateAnalysisRun(
    runId: string,
    userId: string,
    organizationId: string,
    status: AnalysisRunStatus,
    error?: { code: string; message: string },
  ): Promise<boolean> {
    const result = await this.database.execute({
      sql: "UPDATE dbo.analysis_runs SET status = @status, error_code = @error_code, error_message = @error_message, started_at = CASE WHEN @status = 'running' AND started_at IS NULL THEN SYSUTCDATETIME() ELSE started_at END, completed_at = CASE WHEN @status IN ('completed', 'failed', 'cancelled') THEN SYSUTCDATETIME() ELSE completed_at END WHERE id = @id AND user_id = @user_id AND organization_id = @organization_id",
      parameters: [
        { name: "status", type: "string", value: status },
        { name: "error_code", type: "string", value: error?.code ?? null },
        { name: "error_message", type: "string", value: error?.message ?? null },
        { name: "id", type: "string", value: runId },
        { name: "user_id", type: "string", value: userId },
        { name: "organization_id", type: "string", value: organizationId },
      ],
    });
    return (result.rowsAffected[0] ?? 0) > 0;
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
    };
  }
  /** 将数据库消息行转换为会话消息领域对象。 */
  private mapMessage(row: ConversationMessageRow): ConversationMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      sequence: row.sequence,
      createdAt: row.created_at,
    };
  }
}

/** `conversations` 查询返回的数据库记录。 */
type ConversationRow = {
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
