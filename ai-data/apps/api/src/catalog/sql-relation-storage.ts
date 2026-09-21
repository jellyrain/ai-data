import {
  approvedRelationSchema,
  catalogRelationSchema,
  type ApiDatasetConfig,
  type CatalogRelation,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import { relationJsonRowsSchema } from "./catalog-records";

/** 全部目录变更先锁配置再锁关系，避免旧接口与新接口各自覆盖对方状态。 */
async function lockCatalogSource(executor: MetadataQueryExecutor, sourceId: string): Promise<void> {
  const parameters = [{ name: "source_id", type: "string" as const, value: sourceId }];
  await executor.execute({
    sql: "SELECT object_id FROM dbo.api_dataset_configs WITH (UPDLOCK,HOLDLOCK) WHERE source_id=@source_id",
    parameters,
  });
  await executor.execute({
    sql: "SELECT relation_id FROM dbo.approved_relations WITH (UPDLOCK,HOLDLOCK) WHERE source_id=@source_id",
    parameters,
  });
}

/** 数据源内的关系以复合主键独立读取，停用记录仍供管理图和版本检查使用。 */
async function listRelationRecords(
  executor: MetadataQueryExecutor,
  sourceId: string,
): Promise<CatalogRelation[]> {
  const result = await executor.execute({
    sql: "SELECT record_json FROM dbo.approved_relations WHERE source_id=@source_id ORDER BY object_id,relation_id",
    parameters: [{ name: "source_id", type: "string", value: sourceId }],
  });
  return parseStoredRecord(() =>
    relationJsonRowsSchema
      .parse(result.rows)
      .map((row) => catalogRelationSchema.parse(JSON.parse(row.record_json))),
  );
}

/** 同一个关系始终在同一行保留递增版本；调用者持有数据源写锁。 */
async function writeRelationRecord(
  executor: MetadataQueryExecutor,
  record: CatalogRelation,
): Promise<void> {
  await executor.execute({
    sql: `UPDATE dbo.approved_relations SET target_object_id=@target_object_id,version=@version,enabled=@enabled,record_json=@record_json WHERE source_id=@source_id AND object_id=@object_id AND relation_id=@relation_id;
    IF @@ROWCOUNT=0 INSERT INTO dbo.approved_relations(source_id,object_id,relation_id,target_object_id,version,enabled,record_json) VALUES(@source_id,@object_id,@relation_id,@target_object_id,@version,@enabled,@record_json);`,
    parameters: [
      { name: "source_id", type: "string", value: record.source_id },
      { name: "object_id", type: "string", value: record.object_id },
      { name: "relation_id", type: "string", value: record.relation_id },
      { name: "target_object_id", type: "string", value: record.target_object_id },
      { name: "version", type: "integer", value: record.version },
      { name: "enabled", type: "boolean", value: record.enabled },
      { name: "record_json", type: "string", value: JSON.stringify(record) },
    ],
  });
}

/** 旧配置合同仅组装启用关系；内部版本、状态和更新时间不泄漏进原关系结构。 */
function relationDefinitions(
  records: CatalogRelation[],
  objectId: string,
): ApiDatasetConfig["approved_relations"] {
  return records
    .filter((item) => item.object_id === objectId && item.enabled)
    .map((record) =>
      approvedRelationSchema.parse({
        relation_id: record.relation_id,
        target_object_id: record.target_object_id,
        description: record.description,
        column_pairs: record.column_pairs,
        cardinality: record.cardinality,
        allowed_join_types: record.allowed_join_types,
      }),
    );
}

export { lockCatalogSource, listRelationRecords, writeRelationRecord, relationDefinitions };
