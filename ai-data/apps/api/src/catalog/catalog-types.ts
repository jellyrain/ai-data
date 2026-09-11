import type {
  ApiDatasetConfig,
  ColumnPermission,
  Dataset,
  RowPolicy,
  TablePermission,
} from "@ai-data/contracts";

/** API 数据集业务配置的持久化读写边界。 */
interface ApiDatasetConfigRepository {
  /** 保存一项完整业务配置，按数据源和对象覆盖旧版本。 */
  save(config: ApiDatasetConfig): Promise<void>;
  /** 读取一项业务配置；尚未配置时返回空。 */
  find(sourceId: string, objectId: string): Promise<ApiDatasetConfig | null>;
  /** 读取一个数据源的全部业务配置。 */
  listBySourceId(sourceId: string): Promise<ApiDatasetConfig[]>;
}

/** 角色目录权限的持久化读写边界。 */
interface CatalogPermissionRepository {
  /** 保存或覆盖角色对一个对象的访问决定。 */
  saveObjectPermission(sourceId: string, permission: TablePermission): Promise<void>;
  /** 保存或覆盖角色对一个字段的访问决定。 */
  saveColumnPermission(sourceId: string, permission: ColumnPermission): Promise<void>;
  /** 保存或覆盖角色在一个对象上的行策略。 */
  saveRowPolicy(sourceId: string, policy: RowPolicy): Promise<void>;
  /** 读取当前角色集合的对象权限。 */
  listObjectPermissions(roleIds: string[], sourceId: string): Promise<TablePermission[]>;
  /** 读取当前角色集合的字段权限。 */
  listColumnPermissions(roleIds: string[], sourceId: string): Promise<ColumnPermission[]>;
  /** 读取当前角色集合的行策略。 */
  listRowPolicies(roleIds: string[], sourceId: string): Promise<RowPolicy[]>;
}

/** 从 DAS 取得未经业务配置和权限过滤的目录。 */
interface RawCatalogReader {
  /** 返回指定数据源当前由健康 DAS 暴露的目录。 */
  listRawCatalog(sourceId: string): Promise<Dataset[]>;
}

export type { ApiDatasetConfigRepository, CatalogPermissionRepository, RawCatalogReader };
