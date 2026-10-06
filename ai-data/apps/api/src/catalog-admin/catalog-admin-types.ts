import type { QueryAccessContext, QueryDsl } from "@ai-data/contracts";
import type { z } from "zod";
import type { AuthContext } from "../auth/auth-types";
import type { BusinessCatalogService } from "../catalog/business-catalog-service";
import type {
  policyChangeSchema,
  policySnapshotSchema,
  policyVersionSchema,
  policyVersionSummarySchema,
} from "./catalog-admin-schemas";

/** 已完成边界校验的一项角色策略变更。 */
type PolicyChange = z.infer<typeof policyChangeSchema>;
/** 单一源和角色的完整策略快照。 */
type PolicySnapshot = z.infer<typeof policySnapshotSchema>;
/** 管理端可读取的不可变版本和审计资料。 */
type PolicyVersion = z.infer<typeof policyVersionSchema>;
/** 有界版本清单的摘要项。 */
type PolicyVersionSummary = z.infer<typeof policyVersionSummarySchema>;
/** 指定角色独立继承的授权资料；个人例外范围在用户查询时加载。 */
type RoleAuthorization = Pick<
  AuthContext,
  "roles" | "roleIds" | "permissions" | "dataPolicies" | "permissionContext"
>;
/** 管理服务依赖的事务写入、版本读取及角色归属校验能力。 */
interface CatalogAdminRepository {
  /** 读取实际权限表的一致快照与最近角色版本。 */
  currentState(
    organizationId: string,
    sourceId: string,
    roleId: string,
  ): Promise<{ version: number; snapshot: PolicySnapshot }>;
  loadRoleAuthorization(organizationId: string, roleId: string): Promise<RoleAuthorization | null>;
  saveChange(
    context: AuthContext,
    sourceId: string,
    change: PolicyChange,
    expectedVersion?: number,
  ): Promise<PolicyVersion>;
  listVersions(
    organizationId: string,
    sourceId: string,
    roleId: string,
    limit: number,
    beforeVersion?: number,
  ): Promise<PolicyVersionSummary[]>;
  getVersion(
    organizationId: string,
    sourceId: string,
    roleId: string,
    version?: number,
  ): Promise<PolicyVersion | null>;
}
/** 服务具名装配，目录验证与查询转换复用当前业务实现。 */
type CatalogAdminDependencies = {
  repository: CatalogAdminRepository;
  catalog: Pick<BusinessCatalogService, "getAuthorized">;
  authorization: {
    preview(
      query: unknown,
      context: AuthContext,
    ): Promise<{ query: QueryDsl; outputMasks: QueryAccessContext["output_masks"] }>;
  };
};

export type {
  CatalogAdminDependencies,
  CatalogAdminRepository,
  PolicyChange,
  PolicySnapshot,
  PolicyVersion,
  PolicyVersionSummary,
  RoleAuthorization,
};
