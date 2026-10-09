import { queryCapabilitiesSchema } from "@ai-data/contracts";

import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { exposedObjectRowSchema } from "./exposed-object-records";
import { parsePersistedJson } from "./parse-persisted-json";
import type { ExposedSourceObject } from "../catalog/catalog-types";
import { procedureDefinitionSchema } from "../catalog/procedure-definition";

/** 读写 DAS 本地对象白名单，分别为目录发现和查询规划提供映射。 */
class ExposedObjectRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 管理读取包含隐藏和不可查询项，完整替换时保留这些配置。 */
  async listAllBySourceId(sourceId: string, lock = false): Promise<ExposedSourceObject[]> {
    const result = await this.executor.execute({
      sql: `SELECT source_id,object_id,object_kind,native_schema_name,native_object_name,is_discoverable,is_queryable,capabilities_json,procedure_definition_json FROM dbo.exposed_source_objects ${lock ? "WITH (UPDLOCK,HOLDLOCK)" : ""} WHERE source_id=@source_id ORDER BY object_id`,
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });
    return result.rows.map(toExposedSourceObject);
  }

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
          capabilities_json,
          procedure_definition_json
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
          capabilities_json,
          procedure_definition_json
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
    // 对象集合通过单个 JSON 参数传入 OPENJSON，保留管理端确认的查询状态和过程定义。
    const persistedObjects = objects.map((object) => ({
      object_id: object.objectId,
      object_kind: object.objectKind,
      native_schema_name: object.nativeSchemaName ?? null,
      native_object_name: object.nativeObjectName ?? null,
      capabilities_json: JSON.stringify(object.queryCapabilities),
      is_discoverable: object.isDiscoverable,
      is_queryable: object.isQueryable,
      procedure_definition_json:
        object.procedureDefinition === undefined
          ? null
          : JSON.stringify(procedureDefinitionSchema.parse(object.procedureDefinition)),
    }));

    await this.executor.execute({
      sql: `
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        IF NOT EXISTS (SELECT 1 FROM dbo.data_source_configs WITH (UPDLOCK,HOLDLOCK) WHERE source_id=@source_id)
          THROW 50001, 'Data source unavailable', 1;
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
          capabilities_json,
          procedure_definition_json
        )
        SELECT
          @source_id,
          objects.object_id,
          objects.object_kind,
          objects.native_schema_name,
          objects.native_object_name,
          objects.is_discoverable,
          objects.is_queryable,
          objects.capabilities_json,
          objects.procedure_definition_json
        FROM OPENJSON(@objects_json)
        WITH (
          object_id NVARCHAR(256) '$.object_id',
          object_kind VARCHAR(32) '$.object_kind',
          native_schema_name NVARCHAR(128) '$.native_schema_name',
          native_object_name NVARCHAR(256) '$.native_object_name',
          capabilities_json NVARCHAR(MAX) '$.capabilities_json',
          is_discoverable BIT '$.is_discoverable',
          is_queryable BIT '$.is_queryable',
          procedure_definition_json NVARCHAR(MAX) '$.procedure_definition_json'
        ) AS objects;
        COMMIT TRANSACTION;
      `,
      parameters: [
        { name: "source_id", type: "string", value: sourceId },
        { name: "objects_json", type: "string", value: JSON.stringify(persistedObjects) },
      ],
    });
  }
}

/** 校验数据库行与能力 JSON，再转换字段命名；数据库 NULL 对应运行时属性省略。 */
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
    ...(object.procedure_definition_json === null
      ? {}
      : {
          procedureDefinition: parsePersistedJson(
            object.procedure_definition_json,
            procedureDefinitionSchema,
            "exposed_source_objects.procedure_definition_json",
          ),
        }),
  };
}

export { ExposedObjectRepository };
