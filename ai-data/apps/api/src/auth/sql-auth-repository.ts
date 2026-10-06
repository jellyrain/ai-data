import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { z } from "zod";
import { departmentIdsSchema } from "./department-scope";
import { ApplicationError } from "../errors/application-error";
import { SqlUserAdminReader } from "./sql-user-admin-reader";

import type {
  AuthContext,
  AuthSession,
  AuthUser,
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
class SqlAuthRepository implements UserAdminRepository {
  constructor(private readonly database: MetadataQueryExecutor) {}

  /** 按用户名查询并取首条本地账号；此入口使用用户名作为查找条件。 */
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

  /** 更新未撤销会话的摘要和过期时间，再单独查询会话当前值。 */
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
  ): Promise<
    Pick<AuthContext, "roles" | "roleIds" | "permissions" | "dataPolicies" | "permissionContext">
  > {
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
    // 数据范围表保存文本值；in 按逗号拆分，缺失必要字段的记录不会生成策略。
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
    const departments = await this.database.execute({
      sql: "SELECT department_id FROM dbo.user_department_scopes WHERE user_id = @user_id ORDER BY department_id",
      parameters: [{ name: "user_id", type: "string", value: userId }],
    });
    const rows = z
      .array(z.object({ department_id: z.string().min(1).max(128) }).strict())
      .parse(departments.rows);
    return {
      roles,
      roleIds,
      permissions,
      dataPolicies,
      permissionContext: { department_ids: rows.map((row) => row.department_id) },
    };
  }

  /** 按存在性检查补齐默认组织、权限、角色和管理员绑定，已有账号密码保持原值。 */
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
        IF NOT EXISTS (SELECT 1 FROM dbo.permissions WHERE code = 'knowledge:manage')
          INSERT INTO dbo.permissions (id, code, name) VALUES ('permission-knowledge-manage', 'knowledge:manage', N'知识管理');
        IF NOT EXISTS (SELECT 1 FROM dbo.roles WHERE code = 'system_admin')
          INSERT INTO dbo.roles (id, code, name) VALUES ('role-system-admin', 'system_admin', N'系统管理员');
        INSERT INTO dbo.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM dbo.roles r CROSS JOIN dbo.permissions p
          WHERE r.code = 'system_admin' AND p.code IN ('user:manage', 'catalog:manage', 'knowledge:manage')
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

  /** 用户与初始绑定一起提交；HTTP 分配在事务范围锁内复核组织和特权。 */
  async createUser(input: CreateUserInput): Promise<AuthUser> {
    if (!("transaction" in this.database) || typeof this.database.transaction !== "function")
      throw new ApplicationError("INTERNAL_ERROR", "创建用户需要事务数据库");
    return (this.database as MetadataTransactionalExecutor).transaction(async (executor) => {
      if (input.assignmentAuthority) {
        const reader = new SqlUserAdminReader(executor);
        const roles = await reader.roles(
          input.organizationId,
          input.assignmentAuthority.canAssignPrivileged,
        );
        const scopes = await reader.scopes(input.organizationId);
        if (
          input.roleIds.some((id) => !roles.some((role) => role.id === id)) ||
          input.exceptionDataScopeIds.some((id) => !scopes.some((scope) => scope.id === id))
        )
          throw new ApplicationError("INVALID_INPUT", "角色或例外范围不存在或不可分配");
      }
      const duplicate = await executor.execute({
        sql: "SELECT id FROM dbo.users WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@organization_id AND username=@username",
        parameters: [
          { name: "organization_id", type: "string", value: input.organizationId },
          { name: "username", type: "string", value: input.username },
        ],
      });
      if (duplicate.rows.length) throw new ApplicationError("CONFLICT", "用户名已存在");
      await executor.execute({
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
        await executor.execute({
          sql: "INSERT INTO dbo.user_roles (user_id, role_id) VALUES (@user_id, @role_id)",
          parameters: [
            { name: "user_id", type: "string", value: input.id },
            { name: "role_id", type: "string", value: roleId },
          ],
        });
      for (const scopeId of input.exceptionDataScopeIds)
        await executor.execute({
          sql: "INSERT INTO dbo.user_data_scopes (user_id, data_scope_id) VALUES (@user_id, @scope_id)",
          parameters: [
            { name: "user_id", type: "string", value: input.id },
            { name: "scope_id", type: "string", value: scopeId },
          ],
        });
      const user = await new SqlAuthRepository(executor).findUserById(input.id);
      if (!user) throw new Error("用户创建失败");
      return user;
    });
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

  /** 用户行锁将部门替换和版本递增串行化；组织不匹配时不改变任何范围。 */
  async updateUserDepartments(
    userId: string,
    organizationId: string,
    departmentIds: string[],
    expectedAuthorizationVersion?: number,
  ): Promise<boolean> {
    const ids = departmentIdsSchema.parse(departmentIds);
    const result = await this.database.execute({
      sql: `SET XACT_ABORT ON;
        BEGIN TRY
          BEGIN TRANSACTION;
          DECLARE @updated BIT = 0, @conflict BIT = 0;
          IF EXISTS (SELECT 1 FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @user_id AND organization_id = @organization_id)
          BEGIN
            IF @expected_version IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.users WHERE id=@user_id AND authorization_version=@expected_version)
              SET @conflict=1;
            ELSE BEGIN
            DELETE FROM dbo.user_department_scopes WHERE user_id = @user_id;
            INSERT INTO dbo.user_department_scopes (user_id, department_id)
              SELECT @user_id, value FROM OPENJSON(@department_ids);
            UPDATE dbo.users SET authorization_version = authorization_version + 1, updated_at = SYSUTCDATETIME() WHERE id = @user_id;
            SET @updated = 1;
            END;
          END;
          COMMIT TRANSACTION;
          SELECT @updated AS updated, @conflict AS conflict;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
          THROW;
        END CATCH;`,
      parameters: [
        { name: "user_id", type: "string", value: userId },
        { name: "organization_id", type: "string", value: organizationId },
        { name: "department_ids", type: "string", value: JSON.stringify(ids) },
        { name: "expected_version", type: "integer", value: expectedAuthorizationVersion ?? null },
      ],
    });
    if (result.rows[0]?.conflict === true)
      throw new ApplicationError("CONFLICT", "用户授权已更新，请重新读取后保存");
    return result.rows[0]?.updated === true;
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
}

export { SqlAuthRepository };
