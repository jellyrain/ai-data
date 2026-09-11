import { describe, expect, it } from "vitest";

import type {
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "@ai-data/metadata";

import { DataSourceRepository } from "../../src/metadata/data-source-repository";

describe("数据源配置仓储", () => {
  // BDD 场景：同一服务器凭据连接多个 SQL Server 目标库；TDD 断言：每个 source_id 读取自身目标库和独立资源限制。
  it("读取启用数据源的目标库、连接器类型、密钥引用和资源限制", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new DataSourceRepository(
      createExecutor(
        [
          {
            source_id: "clinical_reporting",
            connector_kind: "sqlserver",
            secret_ref: "secret-clinical-reporting",
            target_database: "clinical_reporting",
            oracle_connect_type: null,
            oracle_connect_target: null,
            is_enabled: true,
            timeout_ms: 15000,
            connection_pool_limit: 20,
            concurrency_limit: 8,
            row_limit: 1000,
            cost_limit: 50000,
          },
        ],
        statements,
      ),
    );

    await expect(repository.findEnabledBySourceId("clinical_reporting")).resolves.toEqual({
      sourceId: "clinical_reporting",
      connectorKind: "sqlserver",
      secretRef: "secret-clinical-reporting",
      targetDatabase: "clinical_reporting",
      timeoutMs: 15000,
      connectionPoolLimit: 20,
      concurrencyLimit: 8,
      rowLimit: 1000,
      costLimit: 50000,
    });
    expect(statements[0]?.sql).toContain("is_enabled = 1");
    expect(statements[0]?.sql).not.toContain("clinical_reporting");
    expect(statements[0]?.parameters).toEqual([
      { name: "source_id", type: "string", value: "clinical_reporting" },
    ]);
  });

  // BDD 场景：同一 Oracle 服务器凭据连接不同目标；TDD 断言：SID 或 Service Name 属于 source_id 配置而不属于共享密文。
  it("读取 Oracle 数据源的连接目标", async () => {
    const repository = new DataSourceRepository(
      createExecutor([
        {
          source_id: "clinical_oracle",
          connector_kind: "oracle",
          secret_ref: "secret-clinical-oracle",
          target_database: null,
          oracle_connect_type: "sid",
          oracle_connect_target: "CLINICAL",
          is_enabled: true,
          timeout_ms: 15000,
          connection_pool_limit: 20,
          concurrency_limit: 8,
          row_limit: 1000,
          cost_limit: 50000,
        },
      ]),
    );

    await expect(repository.findEnabledBySourceId("clinical_oracle")).resolves.toMatchObject({
      connectorKind: "oracle",
      secretRef: "secret-clinical-oracle",
      oracleConnectType: "sid",
      oracleConnectTarget: "CLINICAL",
    });
  });

  // BDD 场景：调用方请求不存在或已停用的数据源；TDD 断言：仓储不将其当作可运行连接器配置返回。
  it("找不到启用配置时返回 undefined", async () => {
    const repository = new DataSourceRepository(createExecutor([]));

    await expect(repository.findEnabledBySourceId("disabled_source")).resolves.toBeUndefined();
  });

  // BDD 场景：管理员选择一个目标库保存为 source_id；TDD 断言：配置及资源限制通过参数化语句写入。
  it("保存单库数据源配置", async () => {
    const statements: MetadataStatement[] = [];
    const repository = new DataSourceRepository(createExecutor([], statements));

    await repository.upsert(
      {
        sourceId: "clinical_reporting",
        connectorKind: "sqlserver",
        secretRef: "hospital-sqlserver-reader",
        targetDatabase: "clinical_reporting",
        timeoutMs: 15000,
        connectionPoolLimit: 10,
        concurrencyLimit: 5,
        rowLimit: 1000,
        costLimit: 50000,
      },
      true,
    );

    expect(statements[0]?.sql).toContain("UPDATE dbo.data_source_configs");
    expect(statements[0]?.sql).toContain("INSERT INTO dbo.data_source_configs");
    expect(statements[0]?.parameters).toEqual(
      expect.arrayContaining([
        { name: "target_database", type: "string", value: "clinical_reporting" },
        { name: "is_enabled", type: "boolean", value: true },
      ]),
    );
  });
});

/** 创建记录参数化语句的元数据库执行器替身。 */
function createExecutor(
  rows: Record<string, unknown>[],
  statements: MetadataStatement[] = [],
): MetadataQueryExecutor {
  return {
    async execute<T extends Record<string, unknown>>(
      statement: MetadataStatement,
    ): Promise<MetadataQueryResult<T>> {
      statements.push(statement);
      return { rows: rows as T[], rowsAffected: [0] };
    },
  };
}
