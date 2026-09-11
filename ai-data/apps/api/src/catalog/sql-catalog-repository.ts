import {
  apiDatasetConfigSchema,
  columnPermissionSchema,
  rowPolicySchema,
  tablePermissionSchema,
  type ApiDatasetConfig,
  type ColumnPermission,
  type RowPolicy,
  type TablePermission,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";

import type { ApiDatasetConfigRepository, CatalogPermissionRepository } from "./catalog-types";

/** API 元数据库中保存的 JSON 配置记录。 */
type JsonConfigRow = { config_json: string };
/** API 元数据库中保存的对象权限记录。 */
type ObjectPermissionRow = { role_id: string; object_id: string; effect: "allow" | "deny" };
/** API 元数据库中保存的字段权限记录。 */
type ColumnPermissionRow = {
  role_id: string;
  object_id: string;
  column_name: string;
  effect: "allow" | "deny";
  operations_json: string | null;
};
/** API 元数据库中保存的行策略记录。 */
type RowPolicyRow = { role_id: string; object_id: string; condition_json: string };

/** 使用参数化 SQL 保存 API 业务目录配置和角色目录权限。 */
class SqlCatalogRepository implements ApiDatasetConfigRepository, CatalogPermissionRepository {
  constructor(private readonly database: MetadataQueryExecutor) {}

  /** 保存数据集业务配置 JSON。 */
  async save(config: ApiDatasetConfig): Promise<void> {
    await this.database.execute({
      sql: `UPDATE dbo.api_dataset_configs SET config_json = @config_json, updated_at = SYSUTCDATETIME()
            WHERE source_id = @source_id AND object_id = @object_id;
            IF @@ROWCOUNT = 0 INSERT INTO dbo.api_dataset_configs (source_id, object_id, config_json)
            VALUES (@source_id, @object_id, @config_json);`,
      parameters: [
        { name: "source_id", type: "string", value: config.source_id },
        { name: "object_id", type: "string", value: config.object_id },
        { name: "config_json", type: "string", value: JSON.stringify(config) },
      ],
    });
  }

  /** 读取单个已校验数据集业务配置。 */
  async find(sourceId: string, objectId: string): Promise<ApiDatasetConfig | null> {
    const result = await this.database.execute<JsonConfigRow>({
      sql: "SELECT config_json FROM dbo.api_dataset_configs WHERE source_id = @source_id AND object_id = @object_id",
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "object_id", type: "string", value: objectId },
      ],
    });
    return result.rows[0]
      ? apiDatasetConfigSchema.parse(JSON.parse(result.rows[0].config_json))
      : null;
  }

  /** 读取一个数据源全部已校验业务配置。 */
  async listBySourceId(sourceId: string): Promise<ApiDatasetConfig[]> {
    const result = await this.database.execute<JsonConfigRow>({
      sql: "SELECT config_json FROM dbo.api_dataset_configs WHERE source_id = @source_id",
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });
    return result.rows.map((row) => apiDatasetConfigSchema.parse(JSON.parse(row.config_json)));
  }

  /** 保存角色对象访问决定。 */
  async saveObjectPermission(sourceId: string, permission: TablePermission): Promise<void> {
    await this.database.execute({
      sql: `UPDATE dbo.role_object_permissions SET effect = @effect WHERE source_id = @source_id AND role_id = @role_id AND object_id = @object_id;
            IF @@ROWCOUNT = 0 INSERT INTO dbo.role_object_permissions (source_id, role_id, object_id, effect)
            VALUES (@source_id, @role_id, @object_id, @effect);`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "role_id", type: "string", value: permission.role_id },
        { name: "object_id", type: "string", value: permission.object_id },
        { name: "effect", type: "string", value: permission.effect },
      ],
    });
  }

  /** 保存角色字段访问决定和可用操作。 */
  async saveColumnPermission(sourceId: string, permission: ColumnPermission): Promise<void> {
    await this.database.execute({
      sql: `UPDATE dbo.role_column_permissions SET effect = @effect, operations_json = @operations_json
            WHERE source_id = @source_id AND role_id = @role_id AND object_id = @object_id AND column_name = @column_name;
            IF @@ROWCOUNT = 0 INSERT INTO dbo.role_column_permissions (source_id, role_id, object_id, column_name, effect, operations_json)
            VALUES (@source_id, @role_id, @object_id, @column_name, @effect, @operations_json);`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "role_id", type: "string", value: permission.role_id },
        { name: "object_id", type: "string", value: permission.object_id },
        { name: "column_name", type: "string", value: permission.column },
        { name: "effect", type: "string", value: permission.effect },
        {
          name: "operations_json",
          type: "string",
          value: JSON.stringify(permission.operations ?? null),
        },
      ],
    });
  }

  /** 保存角色对象行过滤条件。 */
  async saveRowPolicy(sourceId: string, policy: RowPolicy): Promise<void> {
    await this.database.execute({
      sql: `UPDATE dbo.role_row_policies SET condition_json = @condition_json
            WHERE source_id = @source_id AND role_id = @role_id AND object_id = @object_id;
            IF @@ROWCOUNT = 0 INSERT INTO dbo.role_row_policies (source_id, role_id, object_id, condition_json)
            VALUES (@source_id, @role_id, @object_id, @condition_json);`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "role_id", type: "string", value: policy.role_id },
        { name: "object_id", type: "string", value: policy.object_id },
        { name: "condition_json", type: "string", value: JSON.stringify(policy.condition) },
      ],
    });
  }

  /** 读取命中角色的对象权限。 */
  async listObjectPermissions(roleIds: string[], sourceId: string): Promise<TablePermission[]> {
    if (roleIds.length === 0) return [];
    const result = await this.database.execute<ObjectPermissionRow>({
      sql: `SELECT role_id, object_id, effect FROM dbo.role_object_permissions
            WHERE source_id = @source_id AND role_id IN (${roleIds.map((_, index) => `@role_id_${index}`).join(", ")})`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        ...roleIds.map((roleId, index) => ({
          name: `role_id_${index}`,
          type: "string" as const,
          value: roleId,
        })),
      ],
    });
    return result.rows.map((row) => tablePermissionSchema.parse(row));
  }

  /** 读取命中角色的字段权限。 */
  async listColumnPermissions(roleIds: string[], sourceId: string): Promise<ColumnPermission[]> {
    if (roleIds.length === 0) return [];
    const result = await this.database.execute<ColumnPermissionRow>({
      sql: `SELECT role_id, object_id, column_name, effect, operations_json FROM dbo.role_column_permissions
            WHERE source_id = @source_id AND role_id IN (${roleIds.map((_, index) => `@role_id_${index}`).join(", ")})`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        ...roleIds.map((roleId, index) => ({
          name: `role_id_${index}`,
          type: "string" as const,
          value: roleId,
        })),
      ],
    });
    return result.rows.map((row) =>
      columnPermissionSchema.parse({
        role_id: row.role_id,
        object_id: row.object_id,
        column: row.column_name,
        effect: row.effect,
        ...(row.operations_json === null ? {} : { operations: JSON.parse(row.operations_json) }),
      }),
    );
  }

  /** 读取命中角色的行策略。 */
  async listRowPolicies(roleIds: string[], sourceId: string): Promise<RowPolicy[]> {
    if (roleIds.length === 0) return [];
    const result = await this.database.execute<RowPolicyRow>({
      sql: `SELECT role_id, object_id, condition_json FROM dbo.role_row_policies
            WHERE source_id = @source_id AND role_id IN (${roleIds.map((_, index) => `@role_id_${index}`).join(", ")})`,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        ...roleIds.map((roleId, index) => ({
          name: `role_id_${index}`,
          type: "string" as const,
          value: roleId,
        })),
      ],
    });
    return result.rows.map((row) =>
      rowPolicySchema.parse({
        role_id: row.role_id,
        object_id: row.object_id,
        effect: "allow",
        condition: JSON.parse(row.condition_json),
      }),
    );
  }
}

export { SqlCatalogRepository };
