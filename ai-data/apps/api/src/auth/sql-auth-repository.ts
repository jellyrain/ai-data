import type { MetadataQueryExecutor } from "@ai-data/metadata";

import type {
  AuthContext,
  AuthSession,
  AuthUser,
  AnalysisRun,
  AnalysisRunStatus,
  Conversation,
  ConversationMessage,
  ConversationRepository,
  CreateUserInput,
  UserAdminRepository,
  UserStatus,
} from "./auth-types";

/** `users` 查询返回的数据库记录。 */
type UserRow = {
  /** 数据库用户主键。 */
  id: string;
  /** 用户所属组织主键。 */
  organization_id: string;
  /** 组织内登录名。 */
  username: string;
  /** 用户展示名称。 */
  display_name: string;
  /** scrypt 密码哈希。 */
  password_hash: string | null;
  /** 用户当前状态。 */
  status: UserStatus;
  /** 权限版本号。 */
  authorization_version: number;
};

/** `auth_sessions` 查询返回的数据库记录。 */
type SessionRow = {
  /** 会话主键。 */
  id: string;
  /** 会话所属用户。 */
  user_id: string;
  /** Refresh Token 哈希。 */
  refresh_token_hash: string;
  /** 会话过期时间。 */
  expires_at: Date;
  /** 会话撤销时间。 */
  revoked_at: Date | null;
};

/** API 认证数据的参数化 SQL Server 仓储。 */
class SqlAuthRepository implements UserAdminRepository, ConversationRepository {
  constructor(private readonly database: MetadataQueryExecutor) {}

  /** 按用户名读取本地账号。 */
  async findUserByUsername(username: string): Promise<AuthUser | null> {
    const result = await this.database.execute<UserRow>({
      sql: "SELECT id, organization_id, username, display_name, password_hash, status, authorization_version FROM dbo.users WHERE username = @username",
      parameters: [{ name: "username", type: "string", value: username }],
    });
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  /** 按用户主键读取本地账号。 */
  async findUserById(userId: string): Promise<AuthUser | null> {
    const result = await this.database.execute<UserRow>({
      sql: "SELECT id, organization_id, username, display_name, password_hash, status, authorization_version FROM dbo.users WHERE id = @user_id",
      parameters: [{ name: "user_id", type: "string", value: userId }],
    });
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  /** 按会话主键读取 Refresh Token 会话。 */
  async findSessionById(sessionId: string): Promise<AuthSession | null> {
    const result = await this.database.execute<SessionRow>({
      sql: "SELECT id, user_id, refresh_token_hash, expires_at, revoked_at FROM dbo.auth_sessions WHERE id = @session_id",
      parameters: [{ name: "session_id", type: "string", value: sessionId }],
    });
    return result.rows[0] ? this.mapSession(result.rows[0]) : null;
  }

  /** 保存新的 Refresh Token 会话。 */
  async createSession(session: AuthSession): Promise<void> {
    await this.database.execute({
      sql: "INSERT INTO dbo.auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES (@id, @user_id, @refresh_token_hash, @expires_at)",
      parameters: [
        { name: "id", type: "string", value: session.id },
        { name: "user_id", type: "string", value: session.userId },
        { name: "refresh_token_hash", type: "string", value: session.refreshTokenHash },
        { name: "expires_at", type: "date", value: session.expiresAt },
      ],
    });
  }

  /** 原子更新 Refresh Token 并返回轮换后的会话。 */
  async rotateSession(
    sessionId: string,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<AuthSession | null> {
    await this.database.execute({
      sql: "UPDATE dbo.auth_sessions SET refresh_token_hash = @refresh_token_hash, expires_at = @expires_at, rotated_at = SYSUTCDATETIME() WHERE id = @session_id AND revoked_at IS NULL",
      parameters: [
        { name: "session_id", type: "string", value: sessionId },
        { name: "refresh_token_hash", type: "string", value: refreshTokenHash },
        { name: "expires_at", type: "date", value: expiresAt },
      ],
    });
    return this.findSessionById(sessionId);
  }

  /** 撤销尚未撤销的会话。 */
  async revokeSession(sessionId: string): Promise<void> {
    await this.database.execute({
      sql: "UPDATE dbo.auth_sessions SET revoked_at = SYSUTCDATETIME() WHERE id = @session_id AND revoked_at IS NULL",
      parameters: [{ name: "session_id", type: "string", value: sessionId }],
    });
  }

  /** 合并角色权限、角色继承范围和用户例外范围。 */
  async loadAuthorization(
    userId: string,
  ): Promise<Pick<AuthContext, "roles" | "roleIds" | "permissions" | "dataPolicies">> {
    const authorizationResult = await this.database.execute<{
      role_code: string;
      role_id: string;
      permission_code: string | null;
    }>({
      sql: "SELECT r.id AS role_id, r.code AS role_code, p.code AS permission_code FROM dbo.user_roles ur JOIN dbo.roles r ON r.id = ur.role_id LEFT JOIN dbo.role_permissions rp ON rp.role_id = r.id LEFT JOIN dbo.permissions p ON p.id = rp.permission_id WHERE ur.user_id = @user_id AND r.status = 'active'",
      parameters: [{ name: "user_id", type: "string", value: userId }],
    });
    const scopeResult = await this.database.execute<{
      resource: string | null;
      field: string | null;
      operator: "eq" | "in" | null;
      value: string | null;
    }>({
      sql: "SELECT ds.resource, ds.field, ds.operator, ds.value FROM dbo.user_roles ur JOIN dbo.roles r ON r.id = ur.role_id JOIN dbo.role_data_scopes rds ON rds.role_id = r.id JOIN dbo.data_scopes ds ON ds.id = rds.data_scope_id WHERE ur.user_id = @user_id AND r.status = 'active' UNION SELECT ds.resource, ds.field, ds.operator, ds.value FROM dbo.user_data_scopes uds JOIN dbo.data_scopes ds ON ds.id = uds.data_scope_id WHERE uds.user_id = @user_id",
      parameters: [{ name: "user_id", type: "string", value: userId }],
    });
    const roles = [...new Set(authorizationResult.rows.map((row) => row.role_code))];
    const roleIds = [...new Set(authorizationResult.rows.map((row) => row.role_id))];
    const permissions = [
      ...new Set(
        authorizationResult.rows.flatMap((row) =>
          row.permission_code ? [row.permission_code] : [],
        ),
      ),
    ];
    const dataPolicies = scopeResult.rows.flatMap((row) =>
      row.resource && row.field && row.operator && row.value
        ? [
            {
              resource: row.resource,
              field: row.field,
              operator: row.operator,
              value: row.operator === "in" ? row.value.split(",") : row.value,
              mandatory: true as const,
            },
          ]
        : [],
    );
    return { roles, roleIds, permissions, dataPolicies };
  }

  /** 幂等创建部署所需的默认管理员基础数据。 */
  async ensureBootstrapAdmin(input: {
    userId: string;
    organizationId: string;
    organizationCode: string;
    organizationName: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }): Promise<void> {
    await this.database.execute({
      sql: `
        IF NOT EXISTS (SELECT 1 FROM dbo.organizations WHERE id = @organization_id)
          INSERT INTO dbo.organizations (id, code, name) VALUES (@organization_id, @organization_code, @organization_name);
        IF NOT EXISTS (SELECT 1 FROM dbo.permissions WHERE code = 'user:manage')
          INSERT INTO dbo.permissions (id, code, name) VALUES ('permission-user-manage', 'user:manage', N'用户管理');
        IF NOT EXISTS (SELECT 1 FROM dbo.permissions WHERE code = 'catalog:manage')
          INSERT INTO dbo.permissions (id, code, name) VALUES ('permission-catalog-manage', 'catalog:manage', N'目录管理');
        IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE code = 'system_admin')
          INSERT INTO dbo.roles (id, code, name) VALUES ('role-system-admin', 'system_admin', N'系统管理员');
        INSERT INTO dbo.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM dbo.roles r CROSS JOIN dbo.permissions p
          WHERE r.code = 'system_admin' AND p.code IN ('user:manage', 'catalog:manage')
            AND NOT EXISTS (SELECT 1 FROM dbo.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);
        IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE organization_id = @organization_id AND username = @username)
          INSERT INTO dbo.users (id, organization_id, username, display_name, password_hash, status)
          VALUES (@user_id, @organization_id, @username, @display_name, @password_hash, 'active');
        INSERT INTO dbo.user_roles (user_id, role_id)
          SELECT u.id, r.id FROM dbo.users u CROSS JOIN dbo.roles r
          WHERE u.organization_id = @organization_id AND u.username = @username AND r.code = 'system_admin'
            AND NOT EXISTS (SELECT 1 FROM dbo.user_roles ur WHERE ur.user_id = u.id AND ur.role_id = r.id);`,
      parameters: [
        { name: "organization_id", type: "string", value: input.organizationId },
        { name: "organization_code", type: "string", value: input.organizationCode },
        { name: "organization_name", type: "string", value: input.organizationName },
        { name: "username", type: "string", value: input.username },
        { name: "display_name", type: "string", value: input.displayName },
        { name: "password_hash", type: "string", value: input.passwordHash },
        { name: "user_id", type: "string", value: input.userId },
      ],
    });
  }

  /** 插入用户并保存其角色和个别例外范围绑定。 */
  async createUser(input: CreateUserInput): Promise<AuthUser> {
    await this.database.execute({
      sql: "INSERT INTO dbo.users (id, organization_id, username, display_name, password_hash, status) VALUES (@id, @organization_id, @username, @display_name, @password_hash, 'active')",
      parameters: [
        { name: "id", type: "string", value: input.id },
        { name: "organization_id", type: "string", value: input.organizationId },
        { name: "username", type: "string", value: input.username },
        { name: "display_name", type: "string", value: input.displayName },
        { name: "password_hash", type: "string", value: input.passwordHash },
      ],
    });
    for (const roleId of input.roleIds)
      await this.database.execute({
        sql: "INSERT INTO dbo.user_roles (user_id, role_id) VALUES (@user_id, @role_id)",
        parameters: [
          { name: "user_id", type: "string", value: input.id },
          { name: "role_id", type: "string", value: roleId },
        ],
      });
    for (const scopeId of input.exceptionDataScopeIds)
      await this.database.execute({
        sql: "INSERT INTO dbo.user_data_scopes (user_id, data_scope_id) VALUES (@user_id, @scope_id)",
        parameters: [
          { name: "user_id", type: "string", value: input.id },
          { name: "scope_id", type: "string", value: scopeId },
        ],
      });
    const user = await this.findUserById(input.id);
    if (!user) throw new Error("用户创建失败");
    return user;
  }

  /** 查询组织内全部用户。 */
  async listUsers(organizationId: string): Promise<AuthUser[]> {
    const result = await this.database.execute<UserRow>({
      sql: "SELECT id, organization_id, username, display_name, password_hash, status, authorization_version FROM dbo.users WHERE organization_id = @organization_id ORDER BY username",
      parameters: [{ name: "organization_id", type: "string", value: organizationId }],
    });
    return result.rows.map((row) => this.mapUser(row));
  }

  /** 更新用户状态并递增授权版本。 */
  async updateUserStatus(
    userId: string,
    organizationId: string,
    status: UserStatus,
  ): Promise<boolean> {
    const result = await this.database.execute({
      sql: "UPDATE dbo.users SET status = @status, authorization_version = authorization_version + 1, updated_at = SYSUTCDATETIME() WHERE id = @user_id AND organization_id = @organization_id",
      parameters: [
        { name: "status", type: "string", value: status },
        { name: "user_id", type: "string", value: userId },
        { name: "organization_id", type: "string", value: organizationId },
      ],
    });
    return (result.rowsAffected[0] ?? 0) > 0;
  }

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

  /** 列出当前用户的会话。 */
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

  /** 追加会话消息。 */
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

  /** 按消息序号读取会话消息。 */
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

  /** 更新当前用户组织内的分析运行状态。 */
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

  /** 将数据库用户行转换为认证领域对象。 */
  private mapUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      organizationId: row.organization_id,
      username: row.username,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      status: row.status,
      authorizationVersion: row.authorization_version,
    };
  }

  /** 将数据库会话行转换为认证领域对象。 */
  private mapSession(row: SessionRow): AuthSession {
    return {
      id: row.id,
      userId: row.user_id,
      refreshTokenHash: row.refresh_token_hash,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
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

export { SqlAuthRepository };
