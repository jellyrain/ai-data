import {
  columnPermissionSchema,
  rowPolicySchema,
  tablePermissionSchema,
  type ColumnPermission,
  type QueryDsl,
  type RowPolicy,
  type TablePermission,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type { CatalogAdminDependencies, PolicyChange } from "./catalog-admin-types";

/** 系统管理员及目录管理权限持有者均受当前组织的角色归属约束。 */
function requireCatalogAdmin(context: AuthContext): void {
  if (!context.roles.includes("system_admin") && !context.permissions.includes("catalog:manage"))
    throw new ApplicationError("UNAUTHORIZED", "无目录管理权限");
}

/** 管理端维护角色策略、读取版本，并按目标角色预览最终授权查询。 */
class CatalogAdminService {
  constructor(private readonly dependencies: CatalogAdminDependencies) {}

  /** 当前规则包含早期初始化数据，不能仅依赖已有审计版本。 */
  async currentState(context: AuthContext, sourceId: string, roleId: string) {
    requireCatalogAdmin(context);
    return this.dependencies.repository.currentState(context.organizationId, sourceId, roleId);
  }

  /** 对象权限经共享合同和当前目录校验后写入事务版本。 */
  async saveObjectPermission(
    context: AuthContext,
    sourceId: string,
    permission: TablePermission,
    expectedVersion?: number,
  ) {
    return this.save(
      context,
      sourceId,
      { kind: "object_permission", permission: tablePermissionSchema.parse(permission) },
      expectedVersion,
    );
  }

  /** 字段存在性在完整管理目录上判断，允许管理员配置角色当前隐藏的字段。 */
  async saveColumnPermission(
    context: AuthContext,
    sourceId: string,
    permission: ColumnPermission,
    expectedVersion?: number,
  ) {
    return this.save(
      context,
      sourceId,
      { kind: "column_permission", permission: columnPermissionSchema.parse(permission) },
      expectedVersion,
    );
  }

  /** 行条件引用的字段必须属于当前源的目标对象。 */
  async saveRowPolicy(
    context: AuthContext,
    sourceId: string,
    permission: RowPolicy,
    expectedVersion?: number,
  ) {
    return this.save(
      context,
      sourceId,
      { kind: "row_policy", permission: rowPolicySchema.parse(permission) },
      expectedVersion,
    );
  }

  private async save(
    context: AuthContext,
    sourceId: string,
    change: PolicyChange,
    expectedVersion?: number,
  ) {
    await this.requireRole(context, change.permission.role_id);
    // 目录管理权限允许维护全目录；该上下文只用于检查 DAS 可用性与对象字段。
    const object = await this.dependencies.catalog.getAuthorized(
      { ...context, roles: ["system_admin"] },
      sourceId,
      change.permission.object_id,
    );
    if (!object) throw new ApplicationError("INVALID_INPUT", "策略引用的数据集不存在");
    const column =
      change.kind === "column_permission"
        ? change.permission.column
        : change.kind === "row_policy"
          ? change.permission.condition.field
          : undefined;
    if (column !== undefined && !object.rawColumns.some((item) => item.name === column))
      throw new ApplicationError("INVALID_INPUT", "策略引用的数据集字段不存在");
    return this.dependencies.repository.saveChange(context, sourceId, change, expectedVersion);
  }

  /** 有界清单中的版本号按同组织、同源的策略提交顺序递增。 */
  async listVersions(
    context: AuthContext,
    sourceId: string,
    roleId: string,
    limit = 20,
    beforeVersion?: number,
  ) {
    await this.requireRole(context, roleId);
    return this.dependencies.repository.listVersions(
      context.organizationId,
      sourceId,
      roleId,
      limit,
      beforeVersion,
    );
  }

  /** version 省略时读取目标角色当前版本。 */
  async getVersion(context: AuthContext, sourceId: string, roleId: string, version?: number) {
    await this.requireRole(context, roleId);
    return this.dependencies.repository.getVersion(
      context.organizationId,
      sourceId,
      roleId,
      version,
    );
  }

  /** 目标角色的权限与范围直接交给共享授权转换，返回最终 DSL 和输出脱敏。 */
  async previewQuery(context: AuthContext, roleId: string, query: QueryDsl) {
    const authorization = await this.requireRole(context, roleId);
    const previewContext: AuthContext = {
      userId: context.userId,
      organizationId: context.organizationId,
      sessionId: context.sessionId,
      ...authorization,
    };
    // 角色预览没有指定实际业务用户，个人绑定策略由真实用户查询时求值。
    const objects = new Set([
      query.from.object_id,
      ...(query.type === "relational_query" ? query.joins.map((join) => join.object_id) : []),
    ]);
    for (const objectId of objects) {
      const object = await this.dependencies.catalog.getAuthorized(
        previewContext,
        query.source_id,
        objectId,
      );
      if (
        object?.rowPolicies.some(
          (policy) => policy.condition.value_from === "permission_context.user_id",
        )
      )
        throw new ApplicationError(
          "POLICY_REJECTED",
          "策略依赖具体用户标识，请通过该用户的查询验证权限",
        );
    }
    const result = await this.dependencies.authorization.preview(query, previewContext);
    return { role_id: roleId, query: result.query, output_masks: result.outputMasks };
  }

  private async requireRole(context: AuthContext, roleId: string) {
    requireCatalogAdmin(context);
    const role = await this.dependencies.repository.loadRoleAuthorization(
      context.organizationId,
      roleId,
    );
    if (!role) throw new ApplicationError("NOT_FOUND", "角色不存在或不属于当前组织");
    return role;
  }
}

export { CatalogAdminService, requireCatalogAdmin };
