import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { dataSourceConfigRowSchema, type DataSourceConfig } from "./metadata-records";

/** 读取 DAS 本地数据源运行配置，不读取或解密任何外部数据源凭据。 */
class DataSourceRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 读取一个已启用的数据源；停用或不存在时不返回可创建连接器的配置。 */
  async findEnabledBySourceId(sourceId: string): Promise<DataSourceConfig | undefined> {
    const result = await this.executor.execute({
      sql: `
        SELECT
          source_id,
          connector_kind,
          secret_ref,
          target_database,
          oracle_connect_type,
          oracle_connect_target,
          is_enabled,
          timeout_ms,
          connection_pool_limit,
          concurrency_limit,
          row_limit,
          cost_limit
        FROM dbo.data_source_configs
        WHERE source_id = @source_id
          AND is_enabled = 1;
      `,
      parameters: [{ name: "source_id", type: "string", value: sourceId }],
    });
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    const config = dataSourceConfigRowSchema.parse(row);
    return {
      sourceId: config.source_id,
      connectorKind: config.connector_kind,
      secretRef: config.secret_ref,
      ...(config.target_database === null ? {} : { targetDatabase: config.target_database }),
      ...(config.oracle_connect_type === null
        ? {}
        : { oracleConnectType: config.oracle_connect_type }),
      ...(config.oracle_connect_target === null
        ? {}
        : { oracleConnectTarget: config.oracle_connect_target }),
      timeoutMs: config.timeout_ms,
      connectionPoolLimit: config.connection_pool_limit,
      concurrencyLimit: config.concurrency_limit,
      rowLimit: config.row_limit,
      costLimit: config.cost_limit,
    };
  }

  /** 列出全部已启用 source_id，供服务心跳汇总数据源健康状态。 */
  async listEnabledSourceIds(): Promise<string[]> {
    const result = await this.executor.execute<{ source_id: string }>({
      sql: "SELECT source_id FROM dbo.data_source_configs WHERE is_enabled = 1 ORDER BY source_id",
      parameters: [],
    });
    return result.rows.map((row) => row.source_id);
  }

  /** 保存一个 source_id 的单库运行配置；调用方随后负责失效旧连接器。 */
  async upsert(config: DataSourceConfig, isEnabled: boolean): Promise<void> {
    await this.executor.execute({
      sql: `
        UPDATE dbo.data_source_configs
        SET connector_kind = @connector_kind,
          secret_ref = @secret_ref,
          target_database = @target_database,
          oracle_connect_type = @oracle_connect_type,
          oracle_connect_target = @oracle_connect_target,
          is_enabled = @is_enabled,
          timeout_ms = @timeout_ms,
          connection_pool_limit = @connection_pool_limit,
          concurrency_limit = @concurrency_limit,
          row_limit = @row_limit,
          cost_limit = @cost_limit,
          updated_at = GETDATE()
        WHERE source_id = @source_id;

        IF @@ROWCOUNT = 0
        BEGIN
          INSERT INTO dbo.data_source_configs (
            source_id,
            connector_kind,
            secret_ref,
            target_database,
            oracle_connect_type,
            oracle_connect_target,
            is_enabled,
            timeout_ms,
            connection_pool_limit,
            concurrency_limit,
            row_limit,
            cost_limit
          )
          VALUES (
            @source_id,
            @connector_kind,
            @secret_ref,
            @target_database,
            @oracle_connect_type,
            @oracle_connect_target,
            @is_enabled,
            @timeout_ms,
            @connection_pool_limit,
            @concurrency_limit,
            @row_limit,
            @cost_limit
          );
        END;
      `,
      parameters: [
        { name: "source_id", type: "string", value: config.sourceId },
        { name: "connector_kind", type: "string", value: config.connectorKind },
        { name: "secret_ref", type: "string", value: config.secretRef },
        { name: "target_database", type: "string", value: config.targetDatabase ?? null },
        {
          name: "oracle_connect_type",
          type: "string",
          value: config.oracleConnectType ?? null,
        },
        {
          name: "oracle_connect_target",
          type: "string",
          value: config.oracleConnectTarget ?? null,
        },
        { name: "is_enabled", type: "boolean", value: isEnabled },
        { name: "timeout_ms", type: "integer", value: config.timeoutMs },
        { name: "connection_pool_limit", type: "integer", value: config.connectionPoolLimit },
        { name: "concurrency_limit", type: "integer", value: config.concurrencyLimit },
        { name: "row_limit", type: "integer", value: config.rowLimit },
        { name: "cost_limit", type: "integer", value: config.costLimit },
      ],
    });
  }
}

export { DataSourceRepository };
