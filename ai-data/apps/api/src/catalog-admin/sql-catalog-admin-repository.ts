import type { ColumnPermission } from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { AuthContext } from "../auth/auth-types";
import { SqlCatalogRepository } from "../catalog/sql-catalog-repository";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import {
  policyVersionRowSchema,
  roleAuthorizationRowsSchema,
  roleScopeRowsSchema,
  sourceRevisionRowSchema,
} from "./catalog-admin-records";
import { policySnapshotSchema, policyVersionSchema } from "./catalog-admin-schemas";
import type {
  CatalogAdminRepository,
  PolicyChange,
  PolicyVersion,
  PolicyVersionSummary,
  RoleAuthorization,
} from "./catalog-admin-types";

dayjs.extend(utc);

/** 元数据参数保持角色、数据源和组织三个独立范围。 */
function policyParameters(organizationId: string, sourceId: string, roleId?: string) {
  return [
    { name: "organization_id", type: "string" as const, value: organizationId },
    { name: "source_id", type: "string" as const, value: sourceId },
    ...(roleId === undefined ? [] : [{ name: "role_id", type: "string" as const, value: roleId }]),
  ];
}

/** 角色为全局主键；只有存在本组织成员且全部成员均属于本组织时才授予管理范围。 */
async function readRole(
  executor: MetadataQueryExecutor,
  organizationId: string,
  roleId: string,
  lock = false,
) {
  const result = await executor.execute({
    sql: `SELECT r.id AS role_id, r.code AS role_code, p.code AS permission_code
      FROM dbo.roles r ${lock ? "WITH (UPDLOCK,HOLDLOCK)" : ""}
      LEFT JOIN dbo.role_permissions rp ON rp.role_id=r.id
      LEFT JOIN dbo.permissions p ON p.id=rp.permission_id
      WHERE r.id=@role_id AND r.status='active'
        AND EXISTS (SELECT 1 FROM dbo.user_roles ur ${lock ? "WITH (HOLDLOCK)" : ""}
          JOIN dbo.users u ${lock ? "WITH (HOLDLOCK)" : ""} ON u.id=ur.user_id
          WHERE ur.role_id=r.id AND u.organization_id=@organization_id)
        AND NOT EXISTS (SELECT 1 FROM dbo.user_roles ur ${lock ? "WITH (HOLDLOCK)" : ""}
          JOIN dbo.users u ${lock ? "WITH (HOLDLOCK)" : ""} ON u.id=ur.user_id
          WHERE ur.role_id=r.id AND u.organization_id <> @organization_id)`,
    parameters: [
      { name: "organization_id", type: "string", value: organizationId },
      { name: "role_id", type: "string", value: roleId },
    ],
  });
  return parseStoredRecord(() => roleAuthorizationRowsSchema.parse(result.rows));
}

/** 外壳和内层 JSON 都属于已持久化记录，校验失败映射为内部数据错误。 */
function parseVersion(row: Record<string, unknown>): PolicyVersion {
  return parseStoredRecord(() =>
    policyVersionSchema.parse(JSON.parse(policyVersionRowSchema.parse(row).record_json) as unknown),
  );
}

/** 在元数据库事务内写策略和不可变快照，源级范围锁确定提交版本顺序。 */
class SqlCatalogAdminRepository implements CatalogAdminRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  /** 复用本地认证的角色权限及角色范围表，读取指定角色的有效授权。 */
  async loadRoleAuthorization(
    organizationId: string,
    roleId: string,
  ): Promise<RoleAuthorization | null> {
    const roles = await readRole(this.database, organizationId, roleId);
    if (roles.length === 0) return null;
    const scopeResult = await this.database.execute({
      sql: `SELECT ds.resource, ds.field, ds.operator, ds.value
        FROM dbo.role_data_scopes rds JOIN dbo.data_scopes ds ON ds.id=rds.data_scope_id
        WHERE rds.role_id=@role_id`,
      parameters: [{ name: "role_id", type: "string", value: roleId }],
    });
    const scopes = parseStoredRecord(() => roleScopeRowsSchema.parse(scopeResult.rows));
    return {
      roles: [...new Set(roles.map((row) => row.role_code))],
      roleIds: [roleId],
      permissions: [
        ...new Set(roles.flatMap((row) => (row.permission_code ? [row.permission_code] : []))),
      ],
      dataPolicies: scopes.map((row) => ({
        resource: row.resource,
        field: row.field,
        operator: row.operator,
        value: row.operator === "in" ? row.value.split(",") : row.value,
        mandatory: true,
      })),
      // 部门白名单属于用户个人资料；纯角色预览使用空集合，由授权器判断可表达性。
      permissionContext: { department_ids: [] },
    };
  }

  /** 策略与包含操作者、变更摘要、当前快照的版本记录一起提交。 */
  async saveChange(
    context: AuthContext,
    sourceId: string,
    change: PolicyChange,
    expectedVersion?: number,
  ): Promise<PolicyVersion> {
    return this.database.transaction(async (executor) => {
      const parameters = policyParameters(
        context.organizationId,
        sourceId,
        change.permission.role_id,
      );
      const revision = await executor.execute({
        sql: `SELECT TOP (1) version FROM dbo.catalog_policy_versions WITH (UPDLOCK,HOLDLOCK)
          WHERE organization_id=@organization_id AND source_id=@source_id ORDER BY version DESC`,
        parameters: policyParameters(context.organizationId, sourceId),
      });
      const currentRevision = revision.rows[0]
        ? parseStoredRecord(() => sourceRevisionRowSchema.parse(revision.rows[0]).version)
        : 0;
      // 事务内再校验成员归属，范围锁覆盖成员变更，避免检查后跨组织赋权。
      if (
        (await readRole(executor, context.organizationId, change.permission.role_id, true))
          .length === 0
      )
        throw new ApplicationError("NOT_FOUND", "角色不存在或不属于当前组织");
      const previousResult = await executor.execute({
        sql: `SELECT TOP (1) record_json FROM dbo.catalog_policy_versions
          WHERE organization_id=@organization_id AND source_id=@source_id AND role_id=@role_id ORDER BY version DESC`,
        parameters,
      });
      const previous = previousResult.rows[0] ? parseVersion(previousResult.rows[0]) : null;
      if (expectedVersion !== undefined && expectedVersion !== (previous?.version ?? 0))
        throw new ApplicationError("CONFLICT", "策略版本已更新，请读取当前版本后重试");
      const permissions = new SqlCatalogRepository(executor);
      if (change.kind === "object_permission")
        await permissions.saveObjectPermission(sourceId, change.permission);
      else if (change.kind === "row_policy")
        await permissions.saveRowPolicy(sourceId, change.permission);
      else await this.saveColumnPermission(executor, sourceId, change.permission);
      const roleIds = [change.permission.role_id];
      const snapshot = policySnapshotSchema.parse({
        object_permissions: await permissions.listObjectPermissions(roleIds, sourceId),
        column_permissions: await permissions.listColumnPermissions(roleIds, sourceId),
        row_policies: await permissions.listRowPolicies(roleIds, sourceId),
      });
      const version = policyVersionSchema.parse({
        organization_id: context.organizationId,
        source_id: sourceId,
        role_id: change.permission.role_id,
        version: currentRevision + 1,
        changed_by: context.userId,
        changed_at: dayjs().utcOffset(8).format("YYYY-MM-DD HH:mm:ss"),
        summary: {
          kind: change.kind,
          object_id: change.permission.object_id,
          effect: change.permission.effect,
          ...(change.kind === "column_permission" ? { column: change.permission.column } : {}),
        },
        change,
        snapshot,
      });
      await executor.execute({
        sql: `INSERT INTO dbo.catalog_policy_versions (organization_id,source_id,role_id,version,record_json)
          VALUES (@organization_id,@source_id,@role_id,@version,@record_json)`,
        parameters: [
          ...parameters,
          { name: "version", type: "integer", value: version.version },
          { name: "record_json", type: "string", value: JSON.stringify(version) },
        ],
      });
      return version;
    });
  }

  /** 同组织同源的所有角色变更共享版本号，供查询签发和证据追溯。 */
  async currentPolicyVersion(context: AuthContext, sourceId: string): Promise<number> {
    const result = await this.database.execute({
      sql: `SELECT TOP (1) version FROM dbo.catalog_policy_versions
        WHERE organization_id=@organization_id AND source_id=@source_id ORDER BY version DESC`,
      parameters: policyParameters(context.organizationId, sourceId),
    });
    return result.rows[0]
      ? parseStoredRecord(() => sourceRevisionRowSchema.parse(result.rows[0]).version)
      : 0;
  }

  /** 版本按倒序和排他游标分页，只返回审计摘要。 */
  async listVersions(
    organizationId: string,
    sourceId: string,
    roleId: string,
    limit: number,
    beforeVersion?: number,
  ): Promise<PolicyVersionSummary[]> {
    const result = await this.database.execute({
      sql: `SELECT TOP (@limit) record_json FROM dbo.catalog_policy_versions
        WHERE organization_id=@organization_id AND source_id=@source_id AND role_id=@role_id
          AND (@before_version IS NULL OR version < @before_version) ORDER BY version DESC`,
      parameters: [
        ...policyParameters(organizationId, sourceId, roleId),
        { name: "limit", type: "integer", value: limit },
        { name: "before_version", type: "integer", value: beforeVersion ?? null },
      ],
    });
    return result.rows.map((row) => {
      const version = parseVersion(row);
      return {
        organization_id: version.organization_id,
        source_id: version.source_id,
        role_id: version.role_id,
        version: version.version,
        changed_by: version.changed_by,
        changed_at: version.changed_at,
        summary: version.summary,
      };
    });
  }

  /** 省略版本时读取当前角色的最新快照，缺失时返回空。 */
  async getVersion(
    organizationId: string,
    sourceId: string,
    roleId: string,
    version?: number,
  ): Promise<PolicyVersion | null> {
    const result = await this.database.execute({
      sql: `SELECT TOP (1) record_json FROM dbo.catalog_policy_versions
        WHERE organization_id=@organization_id AND source_id=@source_id AND role_id=@role_id
          AND (@version IS NULL OR version=@version) ORDER BY version DESC`,
      parameters: [
        ...policyParameters(organizationId, sourceId, roleId),
        { name: "version", type: "integer", value: version ?? null },
      ],
    });
    return result.rows[0] ? parseVersion(result.rows[0]) : null;
  }

  /** 数据库 NULL 表示沿用字段默认操作，显式配置时保存操作数组。 */
  private async saveColumnPermission(
    executor: MetadataQueryExecutor,
    sourceId: string,
    permission: ColumnPermission,
  ) {
    await executor.execute({
      sql: `UPDATE dbo.role_column_permissions SET effect=@effect,operations_json=@operations_json
        WHERE source_id=@source_id AND role_id=@role_id AND object_id=@object_id AND column_name=@column_name;
        IF @@ROWCOUNT=0 INSERT INTO dbo.role_column_permissions (source_id,role_id,object_id,column_name,effect,operations_json)
          VALUES (@source_id,@role_id,@object_id,@column_name,@effect,@operations_json);`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "role_id", type: "string", value: permission.role_id },
        { name: "object_id", type: "string", value: permission.object_id },
        { name: "column_name", type: "string", value: permission.column },
        { name: "effect", type: "string", value: permission.effect },
        {
          name: "operations_json",
          type: "string",
          value: permission.operations === undefined ? null : JSON.stringify(permission.operations),
        },
      ],
    });
  }
}

export { SqlCatalogAdminRepository };
