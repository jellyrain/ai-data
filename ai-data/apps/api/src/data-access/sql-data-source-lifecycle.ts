import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import { lockCatalogSource } from "../catalog/sql-relation-storage";

/** API 实例共享源级应用锁；仅 API 本地清理具有事务原子性，DAS 删除失败依靠回读与重试恢复。 */
class SqlDataSourceLifecycle {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  async run<T>(
    sourceId: string,
    operation: (clear: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (executor) => {
      // 同名源的新建、更新和删除串行，防止清理重试与 API 发起的同名重建交错。
      await executor.execute({
        sql: `DECLARE @result INT;
          EXEC @result = sys.sp_getapplock @Resource=@resource, @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=10000;
          IF @result < 0 THROW 51000, 'Data source is being managed', 1;`,
        parameters: [
          { name: "resource", type: "string", value: `data-source-lifecycle:${sourceId}` },
        ],
      });
      return operation(async () => {
        await lockCatalogSource(executor, sourceId);
        // 历史策略快照、证据、会话、指标与报表定义独立保留；有效授权从当前权限表读取。
        for (const table of [
          "approved_relations",
          "api_dataset_configs",
          "role_object_permissions",
          "role_column_permissions",
          "role_row_policies",
        ]) {
          await executor.execute({
            sql: `DELETE FROM dbo.${table} WHERE source_id=@source_id`,
            parameters: [{ name: "source_id", type: "string", value: sourceId }],
          });
        }
      });
    });
  }
}
export { SqlDataSourceLifecycle };
