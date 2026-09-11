import type { DataPolicy } from "./authorization-types";

/** API 内部用户状态。 */
type UserStatus = "active" | "disabled" | "pending";

/** API 登录用户的最小本地资料。 */
type AuthUser = {
  /** 用户主键。 */
  id: string;
  /** 所属组织主键。 */
  organizationId: string;
  /** 登录名。 */
  username: string;
  /** 展示名称。 */
  displayName: string;
  /** 本地密码派生哈希；SSO 用户为空。 */
  passwordHash: string | null;
  /** 账号状态。 */
  status: UserStatus;
  /** 权限版本，用于令牌和缓存失效。 */
  authorizationVersion: number;
};

/** 当前请求使用的本地角色、功能权限和数据策略。 */
type AuthContext = {
  /** 当前用户主键。 */
  userId: string;
  /** 当前组织主键。 */
  organizationId: string;
  /** 当前会话主键。 */
  sessionId: string;
  /** 当前有效角色编码。 */
  roles: string[];
  /** 当前有效角色主键，供角色授权配置精确匹配。 */
  roleIds?: string[];
  /** 当前有效功能权限编码。 */
  permissions: string[];
  /** 当前有效数据行策略。 */
  dataPolicies: DataPolicy[];
};

/** 登录后创建的服务端会话。 */
type AuthSession = {
  /** 会话主键。 */
  id: string;
  /** 会话所属用户主键。 */
  userId: string;
  /** Refresh Token 的 SHA-256 哈希。 */
  refreshTokenHash: string;
  /** 会话过期时间。 */
  expiresAt: Date;
  /** 撤销时间；未撤销时为空。 */
  revokedAt: Date | null;
};

/** 认证仓储需要的用户和会话读写能力。 */
interface AuthRepository {
  /** 按组织内唯一登录名读取本地用户。 */
  findUserByUsername(username: string): Promise<AuthUser | null>;
  /** 按用户主键读取本地用户。 */
  findUserById(userId: string): Promise<AuthUser | null>;
  /** 按会话主键读取服务端会话。 */
  findSessionById(sessionId: string): Promise<AuthSession | null>;
  /** 持久化新建的 Refresh Token 会话。 */
  createSession(session: AuthSession): Promise<void>;
  /** 原子替换 Refresh Token 哈希并延长会话有效期。 */
  rotateSession(
    sessionId: string,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<AuthSession | null>;
  /** 撤销指定服务端会话。 */
  revokeSession(sessionId: string): Promise<void>;
  /** 汇总用户通过角色和个人例外获得的当前授权。 */
  loadAuthorization(
    userId: string,
  ): Promise<Pick<AuthContext, "roles" | "roleIds" | "permissions" | "dataPolicies">>;
}

type CreateUserInput = {
  /** 新用户稳定标识。 */
  id: string;
  /** 新用户所属组织，由当前管理员上下文确定。 */
  organizationId: string;
  /** 组织内唯一登录名。 */
  username: string;
  /** 用户展示名称。 */
  displayName: string;
  /** 使用 scrypt 派生后的密码哈希。 */
  passwordHash: string;
  /** 初始化绑定的角色标识列表。 */
  roleIds: string[];
  /** 仅用于个别例外的数据范围标识列表。 */
  exceptionDataScopeIds: string[];
};

/** 管理员用户管理所需的仓储能力。 */
interface UserAdminRepository extends AuthRepository {
  /** 幂等创建默认组织、管理员角色、管理权限和管理员账号。 */
  ensureBootstrapAdmin(input: {
    /** 默认管理员用户标识。 */
    userId: string;
    /** 默认组织标识。 */
    organizationId: string;
    /** 默认组织编码。 */
    organizationCode: string;
    /** 默认组织名称。 */
    organizationName: string;
    /** 管理员登录名。 */
    username: string;
    /** 管理员展示名称。 */
    displayName: string;
    /** 管理员密码派生哈希。 */
    passwordHash: string;
  }): Promise<void>;
  /** 在指定组织创建用户并绑定角色和个别例外范围。 */
  createUser(input: CreateUserInput): Promise<AuthUser>;
  /** 按组织列出用户，返回值不得包含密码信息。 */
  listUsers(organizationId: string): Promise<AuthUser[]>;
  /** 更新组织内用户状态并递增授权版本。 */
  updateUserStatus(userId: string, organizationId: string, status: UserStatus): Promise<boolean>;
}

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
  /** 追加一条按序消息。 */
  appendMessage(message: ConversationMessage): Promise<void>;
  /** 读取会话消息。 */
  listMessages(conversationId: string): Promise<ConversationMessage[]>;
  /** 创建分析运行。 */
  createAnalysisRun(run: AnalysisRun): Promise<void>;
  /** 更新分析运行状态。 */
  updateAnalysisRun(
    runId: string,
    userId: string,
    organizationId: string,
    status: AnalysisRunStatus,
    error?: { code: string; message: string },
  ): Promise<boolean>;
}

type Conversation = {
  /** 会话主键。 */
  id: string;
  /** 会话所属组织。 */
  organizationId: string;
  /** 会话创建用户。 */
  userId: string;
  /** 用户可读的会话标题。 */
  title: string | null;
  /** 会话当前状态。 */
  status: "active" | "archived";
  /** 创建时间。 */
  createdAt: Date;
  /** 最后更新时间。 */
  updatedAt: Date;
};

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

/** 分析运行从创建到终态的受控状态集合。 */
type AnalysisRunStatus = "created" | "running" | "completed" | "failed" | "cancelled";

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
  /** 实际开始时间。 */
  startedAt: Date | null;
  /** 结束时间。 */
  completedAt: Date | null;
  /** 创建时间。 */
  createdAt: Date;
};

export type {
  AnalysisRun,
  AnalysisRunStatus,
  AuthContext,
  AuthRepository,
  AuthSession,
  AuthUser,
  Conversation,
  ConversationMessage,
  ConversationRepository,
  CreateUserInput,
  UserAdminRepository,
  UserStatus,
};
