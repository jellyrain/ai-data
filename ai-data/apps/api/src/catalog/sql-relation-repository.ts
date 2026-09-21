import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import type {
  CatalogRelationRepository,
  CatalogRelationTransaction,
} from "./catalog-relation-types";
import { SqlCatalogRepository } from "./sql-catalog-repository";
import {
  listRelationRecords,
  lockCatalogSource,
  writeRelationRecord,
} from "./sql-relation-storage";

/** 新旧入口复用同一关系表和数据源范围锁，批次成功才对查询授权可见。 */
class SqlRelationRepository implements CatalogRelationRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async list(sourceId: string) {
    return listRelationRecords(this.database, sourceId);
  }
  async transaction<T>(
    sourceId: string,
    operation: (transaction: CatalogRelationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (executor) => {
      await lockCatalogSource(executor, sourceId);
      const configs = new SqlCatalogRepository(executor);
      return operation({
        list: () => listRelationRecords(executor, sourceId),
        findConfig: (objectId) => configs.find(sourceId, objectId),
        save: async (record) => {
          await writeRelationRecord(executor, record);
          // 新关系发布改变旧接口读到的完整配置，因此同时推进配置版本。
          await executor.execute({
            sql: `UPDATE dbo.api_dataset_configs SET version=version+1,updated_at=SYSUTCDATETIME() WHERE source_id=@source_id AND object_id=@object_id;
          IF @@ROWCOUNT=0 INSERT INTO dbo.api_dataset_configs(source_id,object_id,config_json) VALUES(@source_id,@object_id,@config_json);`,
            parameters: [
              { name: "source_id", type: "string", value: sourceId },
              { name: "object_id", type: "string", value: record.object_id },
              {
                name: "config_json",
                type: "string",
                value: JSON.stringify({
                  source_id: sourceId,
                  object_id: record.object_id,
                  column_descriptions: [],
                  column_policies: [],
                }),
              },
            ],
          });
        },
      });
    });
  }
}

export { SqlRelationRepository };
