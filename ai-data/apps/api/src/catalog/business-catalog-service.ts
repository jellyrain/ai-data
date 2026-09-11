import type { ApiDatasetConfig, Dataset, RowPolicy, TablePermission } from "@ai-data/contracts";

import type { AuthContext } from "../auth/auth-types";
import type {
  ApiDatasetConfigRepository,
  CatalogPermissionRepository,
  RawCatalogReader,
} from "./catalog-types";

/** 用户目录中一个可用数据集与其有效行策略。 */
type AuthorizedDataset = { dataset: Dataset; rowPolicies: RowPolicy[] };

/** 将 DAS 原始目录、API 业务配置和用户有效权限收敛为业务目录。 */
class BusinessCatalogService {
  constructor(
    private readonly rawCatalog: RawCatalogReader,
    private readonly configRepository: ApiDatasetConfigRepository,
    private readonly permissionRepository: CatalogPermissionRepository,
  ) {}

  /** 返回当前身份可见的一个数据源业务目录。 */
  async listAuthorized(context: AuthContext, sourceId: string): Promise<AuthorizedDataset[]> {
    const [datasets, configs, objectPermissions, columnPermissions, rowPolicies] =
      await Promise.all([
        this.rawCatalog.listRawCatalog(sourceId),
        this.configRepository.listBySourceId(sourceId),
        this.permissionRepository.listObjectPermissions(context.roleIds ?? [], sourceId),
        this.permissionRepository.listColumnPermissions(context.roleIds ?? [], sourceId),
        this.permissionRepository.listRowPolicies(context.roleIds ?? [], sourceId),
      ]);
    const configsByObject = new Map(configs.map((config) => [config.object_id, config]));
    return datasets.flatMap((dataset) => {
      if (!canReadObject(context, dataset.object_id, objectPermissions)) return [];
      const merged = mergeBusinessConfig(dataset, configsByObject.get(dataset.object_id));
      const visibleColumns = visibleDatasetColumns(
        context,
        merged,
        columnPermissions.filter((permission) => permission.object_id === dataset.object_id),
      );
      if (visibleColumns.length === 0) return [];
      return [
        {
          dataset: { ...merged, columns: visibleColumns },
          rowPolicies: rowPolicies.filter((policy) => policy.object_id === dataset.object_id),
        },
      ];
    });
  }

  /** 按对象标识返回当前用户可见的一个业务数据集。 */
  async getAuthorized(
    context: AuthContext,
    sourceId: string,
    objectId: string,
  ): Promise<AuthorizedDataset | null> {
    return (
      (await this.listAuthorized(context, sourceId)).find(
        (item) => item.dataset.object_id === objectId,
      ) ?? null
    );
  }

  /** 读取已授权数据集对应的业务配置，供画布展示批准关联关系。 */
  async getAuthorizedConfig(
    context: AuthContext,
    sourceId: string,
    objectId: string,
  ): Promise<ApiDatasetConfig | null> {
    if (!(await this.getAuthorized(context, sourceId, objectId))) return null;
    return this.configRepository.find(sourceId, objectId);
  }

  /** 在当前用户可见目录中按业务说明、对象名和字段说明搜索。 */
  async searchAuthorized(
    context: AuthContext,
    sourceId: string,
    query: string,
    limit: number,
  ): Promise<AuthorizedDataset[]> {
    const keyword = query.trim().toLocaleLowerCase();
    return (await this.listAuthorized(context, sourceId))
      .filter((item) => catalogSearchText(item.dataset).includes(keyword))
      .slice(0, limit);
  }

  /** 保存管理员提交的数据集业务配置。 */
  async saveConfig(config: ApiDatasetConfig): Promise<void> {
    const datasets = await this.rawCatalog.listRawCatalog(config.source_id);
    const dataset = datasets.find((item) => item.object_id === config.object_id);
    if (!dataset) throw new Error("业务配置引用的数据集不存在");
    const columns = new Set(dataset.columns.map((column) => column.name));
    const relatedColumns = new Map(
      datasets.map((item) => [item.object_id, new Set(item.columns.map((column) => column.name))]),
    );
    for (const description of config.column_descriptions) {
      if (!columns.has(description.field)) throw new Error("字段业务说明引用的数据集字段不存在");
    }
    for (const policy of config.column_policies) {
      if (!columns.has(policy.field)) throw new Error("字段策略引用的数据集字段不存在");
    }
    for (const relation of config.approved_relations) {
      const targetColumns = relatedColumns.get(relation.target_object_id);
      if (!targetColumns) throw new Error("批准关联关系引用的目标数据集不存在");
      for (const pair of relation.column_pairs) {
        if (!columns.has(pair.source_column) || !targetColumns.has(pair.target_column))
          throw new Error("批准关联关系引用的数据集字段不存在");
      }
    }
    await this.configRepository.save(config);
  }
}

/** 系统管理员拥有全量业务目录访问权；其他角色必须具备显式 allow 且未命中 deny。 */
function canReadObject(
  context: AuthContext,
  objectId: string,
  permissions: TablePermission[],
): boolean {
  if (context.roles.includes("system_admin")) return true;
  const matched = permissions.filter((permission) => permission.object_id === objectId);
  return (
    !matched.some((permission) => permission.effect === "deny") &&
    matched.some((permission) => permission.effect === "allow")
  );
}

/** 将 API 的业务说明、粒度、能力和字段策略叠加到 DAS 目录。 */
function mergeBusinessConfig(dataset: Dataset, config: ApiDatasetConfig | undefined): Dataset {
  if (!config) return dataset;
  const descriptions = new Map(
    config.column_descriptions.map((description) => [
      description.field,
      description.business_description,
    ]),
  );
  return {
    ...dataset,
    ...(config.business_description === undefined
      ? {}
      : { source_description: config.business_description }),
    ...(config.query_capabilities === undefined
      ? {}
      : { query_capabilities: config.query_capabilities }),
    columns: dataset.columns.map((column) => ({
      ...column,
      ...(descriptions.has(column.name)
        ? { source_description: descriptions.get(column.name) }
        : {}),
    })),
  };
}

/** 根据字段 allow/deny 规则计算可见列；deny 始终优先，配置 allow 时只开放列出的字段。 */
function visibleDatasetColumns(
  context: AuthContext,
  dataset: Dataset,
  permissions: Awaited<ReturnType<CatalogPermissionRepository["listColumnPermissions"]>>,
): Dataset["columns"] {
  if (context.roles.includes("system_admin")) return dataset.columns;
  const hasAllowRule = permissions.some((permission) => permission.effect === "allow");
  const allowed = new Set(
    permissions
      .filter((permission) => permission.effect === "allow")
      .map((permission) => permission.column),
  );
  const denied = new Set(
    permissions
      .filter((permission) => permission.effect === "deny")
      .map((permission) => permission.column),
  );
  return dataset.columns.filter(
    (column) => !denied.has(column.name) && (!hasAllowRule || allowed.has(column.name)),
  );
}

/** 生成面向目录搜索的统一小写文本。 */
function catalogSearchText(dataset: Dataset): string {
  return [
    dataset.name,
    dataset.object_id,
    dataset.source_description ?? "",
    ...dataset.columns.flatMap((column) => [column.name, column.source_description ?? ""]),
  ]
    .join(" ")
    .toLocaleLowerCase();
}

export { BusinessCatalogService };
export type { AuthorizedDataset };
