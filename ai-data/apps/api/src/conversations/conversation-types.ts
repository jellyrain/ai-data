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
  /** 按调用方分配的序号追加消息，会话归属须在调用前确认。 */
  appendMessage(message: ConversationMessage): Promise<void>;
  /** 按序读取已确认归属的会话消息。 */
  listMessages(conversationId: string): Promise<ConversationMessage[]>;
  /** 创建分析运行。 */
  createAnalysisRun(run: AnalysisRun): Promise<void>;
  /** 更新指定用户及组织所属运行的状态，返回是否命中记录。 */
  updateAnalysisRun(
    runId: string,
    userId: string,
    organizationId: string,
    status: AnalysisRunStatus,
    error?: { code: string; message: string },
  ): Promise<boolean>;
}

/** 当前用户所属组织中的对话会话。 */
type Conversation = {
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

/** 分析运行记录可保存的状态值；状态转换规则由运行流程负责。 */
type AnalysisRunStatus = "created" | "running" | "completed" | "failed" | "cancelled";

/** 一次用户问题对应的分析运行记录。 */
type AnalysisRun = {
  /** 分析运行主键。 */
  id: string;
  /** 所属会话。 */
  conversationId: string;
  /** 所属组织。 */
  organizationId: string;
  /** 发起用户。 */
  userId: string;
  /** 当前运行状态。 */
  status: AnalysisRunStatus;
  /** 稳定失败码。 */
  errorCode: string | null;
  /** 面向用户的失败说明。 */
  errorMessage: string | null;
  /** 首次更新为 running 的时间；尚未启动时为 null。 */
  startedAt: Date | null;
  /** 更新为终态时记录的时间；尚未结束时为 null。 */
  completedAt: Date | null;
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
