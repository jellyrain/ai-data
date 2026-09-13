import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MetadataConnectionConfig } from "@ai-data/metadata";
import { loadSqlServerMigrations, SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";

import { dasConfigSchema } from "../../src/config/das-config";
import { DatabaseConnector } from "../../src/connectors/database-connector";
import { createSqlServerDriver } from "../../src/connectors/database-drivers";
import { sqlServerDialect } from "../../src/connectors/dialects";
import type { ExecutableRelationalQuery } from "../../src/connectors/executable-query";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const migrationDirectories = {
  api: fileURLToPath(new URL("../../../api/migrations/", import.meta.url)),
  das: fileURLToPath(new URL("../../migrations/", import.meta.url)),
};

/** 专用测试实例的管理连接；用 master 创建本轮数据库，实际迁移分别运行在独立库中。 */
function loadTestConfig(): MetadataConnectionConfig {
  const path = process.env.SQLSERVER_TEST_CONFIG;
  if (!path)
    throw new Error(
      "请设置 SQLSERVER_TEST_CONFIG，指向专用 SQL Server 测试配置文件；参见 TESTING.md。",
    );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  } catch {
    throw new Error("SQL Server 测试配置无法读取或不是合法 JSON。");
  }
  const parsed = dasConfigSchema.shape.metadata_sqlserver.safeParse(value);
  if (!parsed.success) throw new Error("SQL Server 测试配置字段无效，请对照示例配置。");
  if (parsed.data.database !== "master")
    throw new Error("SQL Server 测试管理连接必须使用 master。");
  if (!parsed.data.options.encrypt || parsed.data.options.trust_server_certificate) {
    throw new Error("真实业务驱动要求加密并验证服务器证书，请使用受信任证书的专用测试实例。");
  }
  return parsed.data;
}

/** 本轮成功创建的数据库；连接失败时仍记录库名，以便 afterAll 回收。 */
type TestDatabase = { name: string; database?: SqlServerMetadataDatabase };

describe("真实 SQL Server：迁移、结果截断与分层聚合", () => {
  let admin: SqlServerMetadataDatabase | undefined;
  let config: MetadataConnectionConfig;
  const created: TestDatabase[] = [];
  const temporaryDirectories: string[] = [];
  let api: SqlServerMetadataDatabase;
  let das: SqlServerMetadataDatabase;
  let rollback: SqlServerMetadataDatabase;
  let connector: DatabaseConnector | undefined;
  const prefix = "ai_data_test_" + randomUUID().replaceAll("-", "");

  /** 库名仅由本轮随机前缀和固定用途组成，DDL 标识符不能通过 SQL 参数绑定。 */
  function databaseIdentifier(name: string): string {
    if (!name.startsWith(prefix + "_") || !/^ai_data_test_[a-f0-9]{32}_[a-z]+$/.test(name)) {
      throw new Error("临时数据库名称不属于本轮测试");
    }
    return "[" + name + "]";
  }

  async function createDatabase(label: string): Promise<SqlServerMetadataDatabase> {
    if (!admin) throw new Error("测试管理连接尚未建立");
    const name = prefix + "_" + label;
    await admin.execute({ sql: "CREATE DATABASE " + databaseIdentifier(name), parameters: [] });
    const entry: TestDatabase = { name };
    created.push(entry);
    entry.database = await SqlServerMetadataDatabase.connect({
      ...config,
      database: name,
      options: { ...config.options, pool: { ...config.options.pool, max: 1, min: 0 } },
    });
    return entry.database;
  }

  beforeAll(async () => {
    config = loadTestConfig();
    admin = await SqlServerMetadataDatabase.connect(config);
    api = await createDatabase("api");
    das = await createDatabase("das");
    rollback = await createDatabase("rollback");

    await das.execute({
      sql: "CREATE TABLE dbo.truncation_fixture (id INT NOT NULL PRIMARY KEY); INSERT INTO dbo.truncation_fixture VALUES (1), (2), (3);",
      parameters: [],
    });
    await das.execute({
      sql: "CREATE TABLE dbo.average_fixture (visit_id INT NOT NULL, amount INT NOT NULL, department NVARCHAR(8) NOT NULL); INSERT INTO dbo.average_fixture VALUES (1,1,N'A'),(1,2,N'A'),(1,99,N'B'),(2,7,N'A');",
      parameters: [],
    });
    // CREATE PROCEDURE 必须是单独批次的首条语句，过程内部只按受控参数筛选完整结果。
    await das.execute({
      sql: "CREATE PROCEDURE dbo.read_truncation_fixture @max_id INT AS SELECT id FROM dbo.truncation_fixture WHERE id <= @max_id ORDER BY id;",
      parameters: [],
    });
    const source: DataSourceConfig = {
      sourceId: "integration",
      connectorKind: "sqlserver",
      secretRef: "integration",
      targetDatabase: prefix + "_das",
      timeoutMs: config.options.request_timeout_ms,
      connectionPoolLimit: 1,
      concurrencyLimit: 1,
      rowLimit: 2,
      costLimit: 1000,
    };
    const driver = await createSqlServerDriver(source, {
      connectorKind: "sqlserver",
      host: config.server,
      port: config.port,
      user: config.user,
      password: config.password,
    });
    connector = new DatabaseConnector(source, driver, sqlServerDialect);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await connector?.close();
    } catch (error) {
      failures.push(error);
    }
    for (const entry of created) {
      try {
        await entry.database?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await admin?.execute({
          sql: "DROP DATABASE " + databaseIdentifier(entry.name),
          parameters: [],
        });
      } catch (error) {
        failures.push(new Error("清理临时数据库失败：" + entry.name, { cause: error }));
      }
    }
    try {
      await admin?.close();
    } catch (error) {
      failures.push(error);
    }
    for (const target of temporaryDirectories) {
      try {
        const absolute = resolve(target);
        if (
          dirname(absolute) !== resolve(tmpdir()) ||
          !basename(absolute).startsWith("ai-data-sqlserver-integration-")
        ) {
          throw new Error("SQL Server 集成测试临时目录范围无效");
        }
        rmSync(absolute, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "SQL Server 集成测试资源清理失败");
  });

  it.each(["api", "das"] as const)(
    "%s 首次迁移建立业务表，重复迁移保留数据与版本记录",
    async (kind) => {
      const database = kind === "api" ? api : das;
      const table = kind === "api" ? "organizations" : "data_source_secrets";
      const before = await database.execute({
        sql: "SELECT OBJECT_ID(@name, N'U') AS object_id",
        parameters: [{ name: "name", type: "string", value: "dbo." + table }],
      });
      expect(before.rows).toEqual([{ object_id: null }]);
      await database.initializeSchema(migrationDirectories[kind]);
      const versions = await database.execute({
        sql: "SELECT migration_id, applied_at FROM dbo.schema_migrations ORDER BY migration_id",
        parameters: [],
      });
      expect(versions.rows.map((row) => row.migration_id)).toEqual(
        kind === "api"
          ? ["001_initial_auth_schema"]
          : ["001_initial_das_metadata_schema", "002_procedure_definitions"],
      );
      if (kind === "das") {
        const column = await database.execute({
          sql: "SELECT COL_LENGTH(N'dbo.exposed_source_objects', N'procedure_definition_json') AS length;",
          parameters: [],
        });
        expect(column.rows).toEqual([{ length: -1 }]);
      }
      const after = await database.execute({
        sql: "SELECT OBJECT_ID(@name, N'U') AS object_id",
        parameters: [{ name: "name", type: "string", value: "dbo." + table }],
      });
      expect(after.rows[0]?.object_id).toEqual(expect.any(Number));
      const insertSql =
        kind === "api"
          ? "INSERT INTO dbo.organizations (id, code, name) VALUES (N'test_org', N'test_org', N'集成测试组织');"
          : "INSERT INTO dbo.data_source_secrets (secret_ref, encryption_algorithm, key_id, encrypted_payload, encryption_metadata_json) VALUES (N'test_secret', N'AES-256-GCM', N'test_key', 0x0102, N'{}');";
      const selectSql =
        kind === "api"
          ? "SELECT * FROM dbo.organizations"
          : "SELECT * FROM dbo.data_source_secrets";
      await database.execute({ sql: insertSql, parameters: [] });
      const saved = await database.execute({ sql: selectSql, parameters: [] });
      expect(saved.rows).toHaveLength(1);
      await database.initializeSchema(migrationDirectories[kind]);
      await expect(
        database.execute({
          sql: "SELECT migration_id, applied_at FROM dbo.schema_migrations ORDER BY migration_id",
          parameters: [],
        }),
      ).resolves.toEqual(versions);
      await expect(database.execute({ sql: selectSql, parameters: [] })).resolves.toEqual(saved);
    },
  );

  it("迁移提交前失败时回滚业务表和版本标记，停止后续文件，并支持重新迁移", async () => {
    const target = mkdtempSync(join(tmpdir(), "ai-data-sqlserver-integration-"));
    temporaryDirectories.push(target);
    const migrations = loadSqlServerMigrations(migrationDirectories.das);
    for (const migration of migrations) {
      let sql = migration.sql;
      if (migration.fileName === "001_initial_das_metadata_schema.sql") {
        // 在实际迁移写入版本标记之后、提交之前注入错误，验证表和标记的同一事务边界。
        expect(sql.match(/COMMIT TRANSACTION;/g)).toHaveLength(1);
        sql = sql.replace(
          "COMMIT TRANSACTION;",
          "THROW 51001, 'Intentional migration failure.', 1;\nCOMMIT TRANSACTION;",
        );
      }
      writeFileSync(join(target, migration.fileName), sql, "utf8");
    }
    writeFileSync(
      join(target, "999_after_failure.sql"),
      "CREATE TABLE dbo.after_failure (id INT);",
      "utf8",
    );
    await expect(rollback.initializeSchema(target)).rejects.toThrow(
      "Intentional migration failure",
    );
    const state = await rollback.execute({
      sql: "SELECT OBJECT_ID(N'dbo.data_source_secrets', N'U') AS business_table, OBJECT_ID(N'dbo.after_failure', N'U') AS later_table, (SELECT COUNT(*) FROM dbo.schema_migrations) AS versions, @@TRANCOUNT AS transactions;",
      parameters: [],
    });
    expect(state.rows).toEqual([
      { business_table: null, later_table: null, versions: 0, transactions: 0 },
    ]);
    await rollback.initializeSchema(migrationDirectories.das);
    await expect(
      rollback.execute({
        sql: "SELECT migration_id FROM dbo.schema_migrations ORDER BY migration_id",
        parameters: [],
      }),
    ).resolves.toMatchObject({
      rows: [
        { migration_id: "001_initial_das_metadata_schema" },
        { migration_id: "002_procedure_definitions" },
      ],
    });
  });

  it.each([0, 1, 2, 3])("关系查询实际有 %i 行时，真实 TOP 查询正确报告截断", async (count) => {
    const query: ExecutableRelationalQuery = {
      type: "relational_query",
      source_id: "integration",
      timeout_ms: 30000,
      row_limit: 2,
      from: {
        object_id: "fixture",
        native_schema_name: "dbo",
        native_object_name: "truncation_fixture",
        alias: "f",
      },
      joins: [],
      filters: {
        logic: "and",
        items: [
          {
            field: "f.id",
            op: "in",
            data_type: "integer",
            value: count === 0 ? [0] : Array.from({ length: count }, (_, index) => index + 1),
          },
        ],
      },
      select: [{ field: "f.id", as: "id" }],
      group_by: [],
      order_by: [{ field: "f.id", direction: "asc" }],
    };
    const result = await connector!.execute(query);
    expect(result.rows).toEqual(
      Array.from({ length: Math.min(count, 2) }, (_, index) => ({ id: index + 1 })),
    );
    expect(result.row_count).toBe(Math.min(count, 2));
    expect(result.truncated).toBe(count > 2);
  });

  it("整数明细先按权限过滤再求平均，派生字段可按 decimal 参数过滤", async () => {
    const query: ExecutableRelationalQuery = {
      type: "relational_query",
      source_id: "integration",
      timeout_ms: 30000,
      row_limit: 2,
      from: {
        object_id: "average_fixture",
        native_schema_name: "dbo",
        native_object_name: "average_fixture",
        alias: "f",
        filters: {
          logic: "and",
          items: [{ field: "f.department", op: "eq", data_type: "string", value: "A" }],
        },
        pre_aggregate: {
          group_by: ["f.visit_id"],
          select: [
            { field: "f.visit_id", as: "visit_key" },
            { field: "f.amount", aggregation: "avg", as: "mean" },
          ],
        },
      },
      joins: [],
      filters: {
        logic: "and",
        items: [{ field: "f.mean", op: "eq", data_type: "decimal", value: 1.5 }],
      },
      select: [{ field: "f.mean", aggregation: "avg", as: "mean" }],
      group_by: [],
      order_by: [],
    };
    const result = await connector!.execute(query);
    expect(result.columns).toEqual([{ name: "mean", data_type: "decimal" }]);
    expect(result.rows).toEqual([{ mean: 1.5 }]);
    expect(result.truncated).toBe(false);
  });

  it.each([0, 1, 2, 3])("固定存储过程返回 %i 行时，保留参数并正确报告截断", async (count) => {
    const result = await connector!.execute({
      type: "parameterized_query",
      source_id: "integration",
      timeout_ms: 30000,
      row_limit: 2,
      from: {
        object_id: "fixture_procedure",
        native_schema_name: "dbo",
        native_object_name: "read_truncation_fixture",
        alias: "p",
      },
      parameters: [{ name: "max_id", data_type: "integer", value: count }],
      fixed_output: [{ name: "id", data_type: "integer", nullable: false }],
    });
    expect(result.rows).toEqual(
      Array.from({ length: Math.min(count, 2) }, (_, index) => ({ id: index + 1 })),
    );
    expect(result.row_count).toBe(Math.min(count, 2));
    expect(result.truncated).toBe(count > 2);
  });
});
