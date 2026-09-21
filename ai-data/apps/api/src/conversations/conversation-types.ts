import type { AnalysisRun, AnalysisRunStatus } from "../analysis-runs/analysis-run-record-types";

/** API 会话、消息和分析运行的持久化能力。 */
interface ConversationRepository {
  /** 创建当前用户所属组织的会话。 */
  createConversation(conversation: Conversation): Promise<void>;
  /** 查询当前用户可访问的会话。 */
  findConversation(
    conversationId: string,
    userId: string,
    organizationId: string,
  ): Promise<Conversation | null>;
  /** 列出当前用户的会话。 */
  listConversations(userId: string, organizationId: string): Promise<Conversation[]>;
  /** 按序读取已确认归属的会话消息。 */
  listMessages(conversationId: string): Promise<ConversationMessage[]>;
  /** 在会话行锁内幂等保存消息、运行和初始快照。 */
  submitMessage(
    conversationId: string,
    userId: string,
    organizationId: string,
    content: string,
    idempotencyKey: string,
    sessionId?: string,
  ): Promise<SubmittedMessage | null>;
}

/** 当前用户所属组织中的对话会话。 */
type Conversation = {
  /** 创建会话时固定的 Agent 标识；第 8 步前的记录在首次运行时补绑定。 */
  agentId?: string;
  /** 与 Agent 标识配套保存的不可变配置版本。 */
  agentVersion?: number;
  /** 会话主键。 */
  id: string;
  /** 会话所属组织。 */
  organizationId: string;
  /** 会话创建用户。 */
  userId: string;
  /** 用户可读标题；创建时省略则保存为 null。 */
  title: string | null;
  /** active 可接收新消息，archived 表示归档。 */
  status: "active" | "archived";
  /** 创建时间。 */
  createdAt: Date;
  /** 最后更新时间。 */
  updatedAt: Date;
};

/** 按会话内序号持久化的一条对话消息。 */
type ConversationMessage = {
  /** 助手结论与澄清对应的运行；旧记录可以省略。 */
  analysisRunId?: string;
  /** 消息主键。 */
  id: string;
  /** 所属会话。 */
  conversationId: string;
  /** 消息来源角色。 */
  role: "user" | "assistant" | "system" | "tool";
  /** 消息正文。 */
  content: string;
  /** 会话内递增序号。 */
  sequence: number;
  /** 创建时间。 */
  createdAt: Date;
};

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

export type {
  AnalysisRun,
  AnalysisRunStatus,
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationRepository,
  SubmittedMessage,
};
