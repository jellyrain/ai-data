import {
  managedRoleSchema,
  managedDataScopeSchema,
  managedUserAuthorizationSchema,
  type ManagedRole,
  type ManagedDataScope,
  type ManagedUserAuthorization,
  type UserAssignmentOptions,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";

/** 角色只按现有成员确定组织范围；范围锁与账号创建事务共用。 */
const roleOwnershipSql = `EXISTS (SELECT 1 FROM dbo.user_roles ur WITH (HOLDLOCK) JOIN dbo.users u WITH (HOLDLOCK) ON u.id=ur.user_id WHERE ur.role_id=r.id AND u.organization_id=@organization_id)
  AND NOT EXISTS (SELECT 1 FROM dbo.user_roles ur WITH (HOLDLOCK) JOIN dbo.users u WITH (HOLDLOCK) ON u.id=ur.user_id WHERE ur.role_id=r.id AND u.organization_id<>@organization_id)`;
/** 系统管理员或含管理功能的角色需要系统管理员分配。 */
const privilegedRoleSql = `CASE WHEN r.code='system_admin' OR EXISTS (
  SELECT 1 FROM dbo.role_permissions rp WITH (HOLDLOCK) JOIN dbo.permissions p WITH (HOLDLOCK) ON p.id=rp.permission_id
  WHERE rp.role_id=r.id AND p.code LIKE '%:manage') THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END`;
/** 例外范围的组织来源包括直接用户绑定和角色成员，跨组织共享不作为可分配选项。 */
const scopeOwnersSql = `SELECT uds.data_scope_id, u.organization_id FROM dbo.user_data_scopes uds WITH (HOLDLOCK) JOIN dbo.users u WITH (HOLDLOCK) ON u.id=uds.user_id
 UNION SELECT rds.data_scope_id, u.organization_id FROM dbo.role_data_scopes rds WITH (HOLDLOCK) JOIN dbo.user_roles ur WITH (HOLDLOCK) ON ur.role_id=rds.role_id JOIN dbo.users u WITH (HOLDLOCK) ON u.id=ur.user_id`;

/** 管理选择器和授权详情只读取本地元数据库公开字段。 */
class SqlUserAdminReader {
  constructor(private readonly database: MetadataQueryExecutor) {}

  async roles(organizationId: string, canAssignPrivileged = true): Promise<ManagedRole[]> {
    const result = await this.database.execute({
      sql: `SELECT r.id,r.code,r.name,r.status,${privilegedRoleSql} AS is_privileged FROM dbo.roles r WITH (HOLDLOCK)
       WHERE r.status='active' AND ${roleOwnershipSql} ORDER BY r.name,r.id`,
      parameters: [{ name: "organization_id", type: "string", value: organizationId }],
    });
    return parseStoredRecord(() => managedRoleSchema.array().parse(result.rows)).filter(
      (role) => canAssignPrivileged || !role.is_privileged,
    );
  }

  async scopes(organizationId: string): Promise<ManagedDataScope[]> {
    const result = await this.database.execute({
      sql: `WITH scope_owners AS (${scopeOwnersSql})
       SELECT ds.id,ds.resource,ds.field,ds.operator,ds.value FROM dbo.data_scopes ds WITH (HOLDLOCK)
       WHERE EXISTS (SELECT 1 FROM scope_owners o WHERE o.data_scope_id=ds.id AND o.organization_id=@organization_id)
       AND NOT EXISTS (SELECT 1 FROM scope_owners o WHERE o.data_scope_id=ds.id AND o.organization_id<>@organization_id) ORDER BY ds.id`,
      parameters: [{ name: "organization_id", type: "string", value: organizationId }],
    });
    return parseStoredRecord(() => managedDataScopeSchema.array().parse(result.rows));
  }

  async options(
    organizationId: string,
    canAssignPrivileged: boolean,
  ): Promise<UserAssignmentOptions> {
    const roles = await this.roles(organizationId, canAssignPrivileged);
    const exceptionDataScopes = await this.scopes(organizationId);
    const result = await this.database.execute({
      sql: `SELECT DISTINCT d.department_id FROM dbo.user_department_scopes d JOIN dbo.users u ON u.id=d.user_id WHERE u.organization_id=@organization_id ORDER BY d.department_id`,
      parameters: [{ name: "organization_id", type: "string", value: organizationId }],
    });
    const rows = parseStoredRecord(() =>
      z.array(z.object({ department_id: z.string().min(1).max(128) }).strict()).parse(result.rows),
    );
    return {
      roles,
      exception_data_scopes: exceptionDataScopes,
      department_ids: rows.map((row) => row.department_id),
    };
  }

  /** 用户行及绑定在同一事务中读取，授权版本对应本次返回的完整集合。 */
  async authorization(organizationId: string, userId: string): Promise<ManagedUserAuthorization> {
    if (!("transaction" in this.database) || typeof this.database.transaction !== "function")
      throw new ApplicationError("INTERNAL_ERROR", "授权读取需要事务数据库");
    return (this.database as MetadataTransactionalExecutor).transaction(async (executor) => {
      const parameters = [
        { name: "organization_id", type: "string" as const, value: organizationId },
        { name: "user_id", type: "string" as const, value: userId },
      ];
      const user = await executor.execute({
        sql: `SELECT authorization_version FROM dbo.users WITH (HOLDLOCK) WHERE id=@user_id AND organization_id=@organization_id`,
        parameters,
      });
      if (!user.rows[0]) throw new ApplicationError("NOT_FOUND", "用户不存在");
      const roles = await executor.execute({
        sql: `SELECT r.id,r.code,r.name,r.status,${privilegedRoleSql} AS is_privileged FROM dbo.user_roles ur WITH (HOLDLOCK) JOIN dbo.roles r WITH (HOLDLOCK) ON r.id=ur.role_id WHERE ur.user_id=@user_id ORDER BY r.id`,
        parameters,
      });
      const scopes = await executor.execute({
        sql: `SELECT ds.id,ds.resource,ds.field,ds.operator,ds.value FROM dbo.user_data_scopes uds WITH (HOLDLOCK) JOIN dbo.data_scopes ds WITH (HOLDLOCK) ON ds.id=uds.data_scope_id WHERE uds.user_id=@user_id ORDER BY ds.id`,
        parameters,
      });
      const departments = await executor.execute({
        sql: `SELECT department_id FROM dbo.user_department_scopes WITH (HOLDLOCK) WHERE user_id=@user_id ORDER BY department_id`,
        parameters,
      });
      return parseStoredRecord(() =>
        managedUserAuthorizationSchema.parse({
          user_id: userId,
          authorization_version: user.rows[0]!.authorization_version,
          roles: roles.rows,
          exception_data_scopes: scopes.rows,
          department_ids: departments.rows.map((row) => row.department_id),
        }),
      );
    });
  }
}
export { SqlUserAdminReader };
