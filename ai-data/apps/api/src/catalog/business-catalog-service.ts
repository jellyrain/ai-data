import type { ApiDatasetConfig, Dataset, RowPolicy, TablePermission } from "@ai-data/contracts";

import { ApplicationError } from "../errors/application-error";
import type { AuthContext } from "../auth/auth-types";
import type {
  ApiDatasetConfigRepository,
  CatalogPermissionRepository,
  RawCatalogReader,
} from "./catalog-types";
import { resolveParameterDefinitions } from "./parameter-config";
import { validateRelationConfig, validateUniqueKeys } from "./relation-config";

/** 用户目录中一个可用数据集与其有效行策略。 */
type AuthorizedDataset = {
  /** 叠加业务说明并完成对象、可见列过滤的目录项。 */
  dataset: Dataset;
  /** DAS 提供的完整原始字段，只供 API 授权使用，不对调用方返回隐藏列。 */
  rawColumns: Dataset["columns"];
  /** 保留 DAS 的原始能力，查询授权同时检查 API 配置收窄后的能力。 */
  rawQueryCapabilities?: Dataset["query_capabilities"];
  /** 命中当前角色的对象行策略，交给查询转换阶段处理。 */
  rowPolicies: RowPolicy[];
  /** 当前身份中显式获准访问该对象的角色，供计算各角色的完整行范围。 */
  allowedRoleIds: string[];
};

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
    const currentRoles = new Set(context.roleIds ?? []);
    const currentObjectPermissions = objectPermissions.filter((permission) =>
      currentRoles.has(permission.role_id),
    );
    return datasets.flatMap((dataset) => {
      if (!canReadObject(context, dataset.object_id, currentObjectPermissions)) return [];
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
          rawColumns: dataset.columns,
          rawQueryCapabilities: dataset.query_capabilities,
          rowPolicies: rowPolicies.filter(
            (policy) => policy.object_id === dataset.object_id && currentRoles.has(policy.role_id),
          ),
          allowedRoleIds: [
            ...new Set(
              currentObjectPermissions
                .filter(
                  (permission) =>
                    permission.object_id === dataset.object_id && permission.effect === "allow",
                )
                .map((permission) => permission.role_id),
            ),
          ],
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

  /** 对象可见时读取其业务配置，供查询授权和画布使用；返回完整配置记录。 */
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

  /** 保存管理员业务配置前，检查说明、字段策略和批准关联引用的对象与列是否存在。 */
  async saveConfig(config: ApiDatasetConfig): Promise<void> {
    const datasets = await this.rawCatalog.listRawCatalog(config.source_id);
    const dataset = datasets.find((item) => item.object_id === config.object_id);
    if (!dataset) throw new ApplicationError("INVALID_INPUT", "业务配置引用的数据集不存在");
    resolveParameterDefinitions(dataset, config, "INVALID_INPUT");
    const sourceKeys = validateUniqueKeys(config, dataset.columns, "INVALID_INPUT");
    const columns = new Set(dataset.columns.map((column) => column.name));
    const relatedColumns = new Map(
      datasets.map((item) => [item.object_id, new Set(item.columns.map((column) => column.name))]),
    );
    for (const description of config.column_descriptions) {
      if (!columns.has(description.field))
        throw new ApplicationError("INVALID_INPUT", "字段业务说明引用的数据集字段不存在");
    }
    for (const policy of config.column_policies) {
      if (!columns.has(policy.field))
        throw new ApplicationError("INVALID_INPUT", "字段策略引用的数据集字段不存在");
    }
    for (const relation of config.approved_relations) {
      const targetColumns = relatedColumns.get(relation.target_object_id);
      if (!targetColumns)
        throw new ApplicationError("INVALID_INPUT", "批准关联关系引用的目标数据集不存在");
      for (const pair of relation.column_pairs) {
        if (!columns.has(pair.source_column) || !targetColumns.has(pair.target_column))
          throw new ApplicationError("INVALID_INPUT", "批准关联关系引用的数据集字段不存在");
      }
      const targetDataset = datasets.find((item) => item.object_id === relation.target_object_id)!;
      const targetConfig =
        relation.target_object_id === config.object_id
          ? config
          : await this.configRepository.find(config.source_id, relation.target_object_id);
      const targetKeys = validateUniqueKeys(targetConfig, targetDataset.columns, "INVALID_INPUT");
      validateRelationConfig(
        relation,
        dataset.columns,
        targetDataset.columns,
        sourceKeys,
        targetKeys,
        "INVALID_INPUT",
      );
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

/** 用 API 业务说明覆盖目录说明；配置查询能力时替换该能力对象，字段按名称合并说明。 */
function mergeBusinessConfig(dataset: Dataset, config: ApiDatasetConfig | undefined): Dataset {
  const queryParameters = resolveParameterDefinitions(dataset, config);
  if (!config) return { ...dataset, query_parameters: queryParameters };
  const descriptions = new Map(
    config.column_descriptions.map((description) => [
      description.field,
      description.business_description,
    ]),
  );
  return {
    ...dataset,
    query_parameters: queryParameters,
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

/** 系统管理员保留全部列；其他角色中 deny 优先，有 allow 规则时只开放其列出的字段。 */
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
