import { queryCapabilitiesSchema } from "@ai-data/contracts";

import type { MetadataQueryExecutor } from "@ai-data/metadata";
import {
  exposedObjectRowSchema,
  parsePersistedJson,
  type ExposedSourceObject,
} from "./metadata-records";

/** 读取 DAS 本地对象白名单，确保目录与查询都以管理员明确配置的对象为边界。 */
class ExposedObjectRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 列出某数据源允许向 API 发现的对象。 */
  async listDiscoverableBySourceId(sourceId: string): Promise<ExposedSourceObject[]> {
    const result = await this.executor.execute({
      sql: `
        SELECT
          source_id,
          object_id,
          object_kind,
          native_schema_name,
          native_object_name,
          is_discoverable,
          is_queryable,
          capabilities_json
        FROM dbo.exposed_source_objects
        WHERE source_id = @source_id
          AND is_discoverable = 1
        ORDER BY object_id;
      `,
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });

    return result.rows.map((row) => toExposedSourceObject(row));
  }

  /** 读取一个允许执行查询的对象，并保留它的物理名称映射给查询规划器使用。 */
  async findQueryableBySourceIdAndObjectId(
    sourceId: string,
    objectId: string,
  ): Promise<ExposedSourceObject | undefined> {
    const result = await this.executor.execute({
      sql: `
        SELECT
          source_id,
          object_id,
          object_kind,
          native_schema_name,
          native_object_name,
          is_discoverable,
          is_queryable,
          capabilities_json
        FROM dbo.exposed_source_objects
        WHERE source_id = @source_id
          AND object_id = @object_id
          AND is_queryable = 1;
      `,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "object_id", type: "string", value: objectId },
      ],
    });
    const row = result.rows[0];

    return row === undefined ? undefined : toExposedSourceObject(row);
  }

  /** 以管理员本次勾选结果替换一个数据源的完整 API 对象白名单。 */
  async replaceForSource(sourceId: string, objects: ExposedSourceObject[]): Promise<void> {
    const persistedObjects = objects.map((object) => ({
      object_id: object.objectId,
      object_kind: object.objectKind,
      native_schema_name: object.nativeSchemaName ?? null,
      native_object_name: object.nativeObjectName ?? null,
      capabilities_json: JSON.stringify(object.queryCapabilities),
    }));

    await this.executor.execute({
      sql: `
        DELETE FROM dbo.exposed_source_objects
        WHERE source_id = @source_id;

        INSERT INTO dbo.exposed_source_objects (
          source_id,
          object_id,
          object_kind,
          native_schema_name,
          native_object_name,
          is_discoverable,
          is_queryable,
          capabilities_json
        )
        SELECT
          @source_id,
          objects.object_id,
          objects.object_kind,
          objects.native_schema_name,
          objects.native_object_name,
          1,
          1,
          objects.capabilities_json
        FROM OPENJSON(@objects_json)
        WITH (
          object_id NVARCHAR(256) '$.object_id',
          object_kind VARCHAR(32) '$.object_kind',
          native_schema_name NVARCHAR(128) '$.native_schema_name',
          native_object_name NVARCHAR(256) '$.native_object_name',
          capabilities_json NVARCHAR(MAX) '$.capabilities_json'
        ) AS objects;
      `,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "objects_json", type: "string", value: JSON.stringify(persistedObjects) },
      ],
    });
  }
}

/** 将数据库 snake_case 记录和 JSON 配置转换为应用内部对象。 */
function toExposedSourceObject(row: Record<string, unknown>): ExposedSourceObject {
  const object = exposedObjectRowSchema.parse(row);
  const queryCapabilities = parsePersistedJson(
    object.capabilities_json,
    queryCapabilitiesSchema,
    "exposed_source_objects.capabilities_json",
  );

  return {
    sourceId: object.source_id,
    objectId: object.object_id,
    objectKind: object.object_kind,
    ...(object.native_schema_name === null ? {} : { nativeSchemaName: object.native_schema_name }),
    ...(object.native_object_name === null ? {} : { nativeObjectName: object.native_object_name }),
    isDiscoverable: object.is_discoverable,
    isQueryable: object.is_queryable,
    queryCapabilities,
  };
}

export { ExposedObjectRepository };
