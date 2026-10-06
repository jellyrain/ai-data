import { createHash } from "node:crypto";
import { z } from "zod";
import {
  stableStringify,
  managedDataSourceSchema,
  managedSourceObjectSchema,
  managedSecretReferenceSchema,
  type ManagedDataSource,
  type ManagedSourceObject,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import { DataSourceRepository } from "./data-source-repository";
import { ExposedObjectRepository } from "./exposed-object-repository";
import { dataSourceConfigRowSchema } from "./data-source-records";
import { ManagementConflict } from "../data-sources/management-conflict";
import type { DataSourceConfig } from "../data-sources/data-source-types";
import type { ExposedSourceObject } from "../catalog/catalog-types";

/** 指纹只用于比较公开配置，稳定序列化不受 JSON 属性顺序影响。 */
function managementRevision(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
/** 显式映射白名单公开字段，凭据与执行器状态不进入浏览器。 */
function publicSourceObject(item: ExposedSourceObject): ManagedSourceObject {
  return managedSourceObjectSchema.parse({
    source_id: item.sourceId,
    object_id: item.objectId,
    object_kind: item.objectKind,
    native_schema_name: item.nativeSchemaName,
    native_object_name: item.nativeObjectName,
    is_discoverable: item.isDiscoverable,
    is_queryable: item.isQueryable,
    query_capabilities: item.queryCapabilities,
    procedure_definition: item.procedureDefinition,
  });
}
/** 直接从元数据库读取管理配置，不依赖业务连接器是否可以连接。 */
class SqlDataSourceAdministration {
  constructor(private readonly database: MetadataTransactionalExecutor) {}

  private async readSources(
    executor: MetadataQueryExecutor,
    sourceId?: string,
  ): Promise<ManagedDataSource[]> {
    const result = await executor.execute({
      sql: `SELECT source_id,connector_kind,secret_ref,target_database,oracle_connect_type,oracle_connect_target,is_enabled,timeout_ms,connection_pool_limit,concurrency_limit,row_limit,cost_limit FROM dbo.data_source_configs ${sourceId === undefined ? "" : "WHERE source_id=@source_id"} ORDER BY source_id`,
      parameters:
        sourceId === undefined ? [] : [{ name: "source_id", type: "string", value: sourceId }],
    });
    return result.rows.map((value) => {
      const row = dataSourceConfigRowSchema.parse(value);
      return managedDataSourceSchema.parse({
        ...row,
        target_database: row.target_database ?? undefined,
        oracle_connect_type: row.oracle_connect_type ?? undefined,
        oracle_connect_target: row.oracle_connect_target ?? undefined,
      });
    });
  }
  async sources() {
    return { items: await this.readSources(this.database) };
  }
  async source(sourceId: string) {
    const config = (await this.readSources(this.database, sourceId))[0] ?? null;
    return { config, revision: managementRevision(config) };
  }
  async objects(sourceId: string) {
    return this.database.transaction(async (executor) => {
      await this.lock(executor, sourceId);
      const config = (await this.readSources(executor, sourceId))[0] ?? null;
      const items = await new ExposedObjectRepository(executor).listAllBySourceId(sourceId, true);
      return {
        items,
        revision: managementRevision({ config, items: items.map(publicSourceObject) }),
      };
    });
  }
  async secrets() {
    const result = await this.database.execute({
      sql: `SELECT secret_ref FROM dbo.data_source_secrets UNION SELECT secret_ref FROM dbo.data_source_configs ORDER BY secret_ref`,
      parameters: [],
    });
    const refs = z.array(z.object({ secret_ref: z.string().min(1) }).strict()).parse(result.rows);
    const sources = await this.readSources(this.database);
    const existing = await this.database.execute({
      sql: "SELECT secret_ref FROM dbo.data_source_secrets",
      parameters: [],
    });
    const present = new Set(
      z
        .array(z.object({ secret_ref: z.string().min(1) }).strict())
        .parse(existing.rows)
        .map((row) => row.secret_ref),
    );
    return {
      items: refs.map(({ secret_ref }) =>
        managedSecretReferenceSchema.parse({
          secret_ref,
          exists: present.has(secret_ref),
          source_ids: sources
            .filter((source) => source.secret_ref === secret_ref)
            .map((source) => source.source_id),
        }),
      ),
    };
  }
  /** 同源配置和白名单共享锁，首次创建也锁住缺失主键范围。 */
  private async lock(executor: MetadataQueryExecutor, sourceId: string) {
    await executor.execute({
      sql: "SELECT source_id FROM dbo.data_source_configs WITH (UPDLOCK,HOLDLOCK) WHERE source_id=@source_id",
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });
  }
  async saveSource(
    config: DataSourceConfig,
    isEnabled: boolean,
    expectedRevision: string,
  ): Promise<void> {
    await this.database.transaction(async (executor) => {
      await this.lock(executor, config.sourceId);
      const current = (await this.readSources(executor, config.sourceId))[0] ?? null;
      if (managementRevision(current) !== expectedRevision) throw new ManagementConflict();
      await new DataSourceRepository(executor).upsert(config, isEnabled);
    });
  }
  async saveObjects(
    sourceId: string,
    objects: ExposedSourceObject[],
    expectedRevision: string,
  ): Promise<void> {
    await this.database.transaction(async (executor) => {
      await this.lock(executor, sourceId);
      const repository = new ExposedObjectRepository(executor);
      const config = (await this.readSources(executor, sourceId))[0] ?? null;
      const current = await repository.listAllBySourceId(sourceId, true);
      if (
        managementRevision({ config, items: current.map(publicSourceObject) }) !== expectedRevision
      )
        throw new ManagementConflict();
      await repository.replaceForSource(sourceId, objects);
    });
  }
}
export { SqlDataSourceAdministration, managementRevision, publicSourceObject };
