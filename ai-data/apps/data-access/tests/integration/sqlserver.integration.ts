import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_QUERY_TABLE_BYTES, queryResultSchema, type QueryDsl } from "@ai-data/contracts";
import type { MetadataConnectionConfig } from "@ai-data/metadata";
import { loadSqlServerMigrations, SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";

import { InternalQueryVerifier } from "../../src/auth/internal-query-verifier";
import { dasConfigSchema } from "../../src/config/das-config";
import { DatabaseConnector } from "../../src/connectors/database-connector";
import type { DatabaseDriver } from "../../src/connectors/database-connector";
import { AuditRepository } from "../../src/metadata/audit-repository";
import { AuditedQueryService } from "../../src/query-execution/audited-query-service";
import {
  createInternalToken,
  createSignedRequest,
  publicPem,
} from "../support/internal-query-fixtures";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";
import { executableQuerySchema } from "../../src/connectors/executable-query";
import { createSqlServerDriver } from "../../src/connectors/database-drivers";
import { sqlServerDialect } from "../../src/connectors/dialects";
import type { ExecutableRelationalQuery } from "../../src/connectors/executable-query";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";
import { QueryExecutionService } from "../../src/query-execution/query-execution-service";
import { QueryPlanner } from "../../src/query-planning/query-planner";
import { registerQueryRoute } from "../../src/routes/query-route";

dayjs.extend(utc);

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
  // 应用配置只复用连接信息，测试始终切换到 master 并自行创建隔离库。
  const connection =
    value && typeof value === "object" && "metadata_sqlserver" in value
      ? { ...(value.metadata_sqlserver as object), database: "master" }
      : value;
  const parsed = dasConfigSchema.shape.metadata_sqlserver.safeParse(connection);
  if (!parsed.success) throw new Error("SQL Server 测试配置字段无效，请对照示例配置。");
  if (parsed.data.database !== "master")
    throw new Error("SQL Server 测试管理连接必须使用 master。");
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
  let driver: DatabaseDriver;
  let source: DataSourceConfig;
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
    await das.execute({
      sql: "CREATE TABLE dbo.types_fixture (id INT NOT NULL, amount DECIMAL(12,2), flag BIT, day DATE, time_value TIME, happened DATETIME2, bytes VARBINARY(10), empty_value NVARCHAR(10)); INSERT INTO dbo.types_fixture VALUES (1,12.25,1,'2026-09-14','02:00:00','2026-09-14T02:00:00',0x0102,NULL);",
      parameters: [],
    });
    // CREATE PROCEDURE 必须是单独批次的首条语句，过程内部只按受控参数筛选完整结果。
    await das.execute({
      sql: "CREATE PROCEDURE dbo.read_truncation_fixture @max_id INT AS SELECT id FROM dbo.truncation_fixture WHERE id <= @max_id ORDER BY id;",
      parameters: [],
    });
    source = {
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
    driver = await createSqlServerDriver(
      source,
      {
        connectorKind: "sqlserver",
        host: config.server,
        port: config.port,
        user: config.user,
        password: config.password,
      },
      {
        encrypt: config.options.encrypt,
        trustServerCertificate: config.options.trust_server_certificate,
      },
    );
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
        kind === "api" ? ["001_initial_api_schema"] : ["001_initial_das_metadata_schema"],
      );
      if (kind === "api") {
        const columns = await database.execute({
          sql: `SELECT t.name AS table_name, c.name AS column_name, c.is_nullable
            FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
            WHERE (t.name IN ('conversations', 'analysis_runs') AND c.name IN ('agent_id', 'agent_version'))
              OR (t.name = 'conversation_messages' AND c.name = 'analysis_run_id')
              OR (t.name = 'model_configuration_versions' AND c.name IN ('key_id', 'encrypted_payload', 'encryption_metadata_json'))
            ORDER BY t.name, c.name;`,
          parameters: [],
        });
        expect(columns.rows).toEqual([
          { table_name: "analysis_runs", column_name: "agent_id", is_nullable: true },
          { table_name: "analysis_runs", column_name: "agent_version", is_nullable: true },
          {
            table_name: "conversation_messages",
            column_name: "analysis_run_id",
            is_nullable: true,
          },
          { table_name: "conversations", column_name: "agent_id", is_nullable: true },
          { table_name: "conversations", column_name: "agent_version", is_nullable: true },
          {
            table_name: "model_configuration_versions",
            column_name: "encrypted_payload",
            is_nullable: false,
          },
          {
            table_name: "model_configuration_versions",
            column_name: "encryption_metadata_json",
            is_nullable: false,
          },
          { table_name: "model_configuration_versions", column_name: "key_id", is_nullable: false },
        ]);
        const constraints = await database.execute({
          sql: `SELECT name FROM sys.check_constraints
            WHERE name IN ('CK_conversations_agent_binding', 'CK_analysis_runs_agent_binding')
            ORDER BY name;`,
          parameters: [],
        });
        expect(constraints.rows).toEqual([
          { name: "CK_analysis_runs_agent_binding" },
          { name: "CK_conversations_agent_binding" },
        ]);
        const indexes = await database.execute({
          sql: `SELECT name FROM sys.indexes
            WHERE name IN ('IX_analysis_runs_dispatch', 'ix_catalog_policy_role_versions')
            ORDER BY name;`,
          parameters: [],
        });
        expect(indexes.rows).toEqual([
          { name: "IX_analysis_runs_dispatch" },
          { name: "ix_catalog_policy_role_versions" },
        ]);
      } else {
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

  it.each(["api", "das"] as const)(
    "%s 迁移提交前失败时回滚业务表和版本标记，停止后续文件，并支持重新迁移",
    async (kind) => {
      const target = mkdtempSync(join(tmpdir(), "ai-data-sqlserver-integration-"));
      temporaryDirectories.push(target);
      const rollbackDatabase = kind === "api" ? await createDatabase("apirollback") : rollback;
      const migrationId =
        kind === "api" ? "001_initial_api_schema" : "001_initial_das_metadata_schema";
      const migrations = loadSqlServerMigrations(migrationDirectories[kind]);
      for (const migration of migrations) {
        let sql = migration.sql;
        if (migration.fileName === migrationId + ".sql") {
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
      await expect(rollbackDatabase.initializeSchema(target)).rejects.toThrow(
        "Intentional migration failure",
      );
      const state = await rollbackDatabase.execute({
        sql: "SELECT (SELECT COUNT(*) FROM sys.tables WHERE name <> N'schema_migrations') AS business_tables, (SELECT COUNT(*) FROM dbo.schema_migrations) AS versions, @@TRANCOUNT AS transactions;",
        parameters: [],
      });
      expect(state.rows).toEqual([{ business_tables: 0, versions: 0, transactions: 0 }]);
      await rollbackDatabase.initializeSchema(migrationDirectories[kind]);
      await expect(
        rollbackDatabase.execute({
          sql: "SELECT migration_id FROM dbo.schema_migrations ORDER BY migration_id",
          parameters: [],
        }),
      ).resolves.toMatchObject({
        rows: [{ migration_id: migrationId }],
      });
    },
  );

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

  it.each([false, true])("真实列类型与空结果经过统一转换，空结果=$0", async (empty) => {
    const query: ExecutableRelationalQuery = {
      type: "relational_query",
      source_id: "integration",
      timeout_ms: 30000,
      row_limit: 2,
      from: {
        object_id: "types_fixture",
        native_schema_name: "dbo",
        native_object_name: "types_fixture",
        alias: "t",
      },
      joins: [],
      group_by: [],
      order_by: [],
      filters: {
        logic: "and",
        items: [{ field: "t.id", op: "eq", data_type: "integer", value: empty ? 0 : 1 }],
      },
      select: ["id", "amount", "flag", "day", "time_value", "happened", "bytes", "empty_value"].map(
        (field) => ({ field: "t." + field, as: field }),
      ),
    };
    const result = await connector!.execute(query);
    expect(result.columns.map((column) => column.data_type)).toEqual([
      "integer",
      "decimal",
      "boolean",
      "date",
      "string",
      "datetime",
      "buffer",
      "string",
    ]);
    expect(result.rows).toEqual(
      empty
        ? []
        : [
            {
              id: 1,
              amount: 12.25,
              flag: true,
              day: "2026-09-14",
              time_value: "02:00:00",
              happened: "2026-09-14 02:00:00",
              bytes: "AQI=",
              empty_value: null,
            },
          ],
    );
  });

  it("带值 ON 保留不满足左侧匹配条件以及完全无明细的主记录", async () => {
    const compiled = compileSqlQuery(
      executableQuerySchema.parse({
        type: "relational_query",
        source_id: "integration",
        timeout_ms: 30000,
        row_limit: 20,
        from: {
          object_id: "fixture",
          native_schema_name: "dbo",
          native_object_name: "truncation_fixture",
          alias: "v",
        },
        joins: [
          {
            type: "left",
            relation: {
              object_id: "average_fixture",
              native_schema_name: "dbo",
              native_object_name: "average_fixture",
              alias: "a",
              filters: {
                logic: "and",
                items: [{ field: "a.department", op: "eq", data_type: "string", value: "A" }],
              },
            },
            on: [{ left: "v.id", op: "eq", right: "a.visit_id" }],
            on_filters: {
              logic: "and",
              items: [{ field: "v.id", op: "eq", data_type: "integer", value: 1 }],
            },
          },
        ],
        select: [
          { field: "v.id", as: "id" },
          { field: "a.amount", as: "amount" },
        ],
        filters: { logic: "and", items: [] },
        group_by: [],
        order_by: [
          { field: "v.id", direction: "asc" },
          { field: "a.amount", direction: "asc" },
        ],
      }),
      sqlServerDialect,
    );
    expect(compiled.parameters.map((parameter) => parameter.value)).toEqual(["A", 1]);
    expect((await driver.query(compiled.sql, compiled.parameters)).rows).toEqual([
      { id: 1, amount: 1 },
      { id: 1, amount: 2 },
      { id: 2, amount: null },
      { id: 3, amount: null },
    ]);
  });

  it.each(["cancel", "timeout"])("真实慢查询 %s 后单连接池仍能执行请求", async (mode) => {
    const controller = new AbortController();
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      await expect(
        driver.query("WAITFOR DELAY '00:00:05'; SELECT 1 AS id", [], {
          signal: controller.signal,
          timeoutMs: mode === "timeout" ? 100 : 3000,
        }),
      ).rejects.toMatchObject({ code: mode === "cancel" ? "CANCELLED" : "QUERY_TIMEOUT" });
      expect((await driver.query("SELECT 2 AS id", [])).rows).toEqual([{ id: 2 }]);
    } finally {
      clearTimeout(timer);
    }
  });

  it.each(["executed", "rejected", "timed_out", "failed"] as const)(
    "请求边界将 %s 审计实际写入 SQL Server",
    async (outcome) => {
      const id = randomUUID();
      const service = new AuditedQueryService(
        {
          execute: async () => {
            if (outcome !== "executed")
              throw Object.assign(new Error("query failure"), {
                code: outcome === "timed_out" ? "QUERY_TIMEOUT" : "INTERNAL_ERROR",
              });
            const result = await driver.query("SELECT 1 AS id", []);
            return {
              columns: [{ name: "id", data_type: "integer" }],
              rows: result.rows,
              row_count: 1,
              truncated: false,
            };
          },
        },
        {
          verify: async () => {
            if (outcome === "rejected") throw new Error("signature rejected");
          },
        },
        new AuditRepository(das),
      );
      const action = service.execute(createSignedRequest(), "test-token", { correlationId: id });
      if (outcome === "executed") await expect(action).resolves.toMatchObject({ row_count: 1 });
      else await expect(action).rejects.toBeInstanceOf(Error);
      const audit = await das.execute({
        sql: "SELECT outcome, user_id, parameters_summary_json, query_summary_json FROM dbo.query_audit_logs WHERE correlation_id = @id",
        parameters: [{ name: "id", type: "string", value: id }],
      });
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        outcome,
        user_id: outcome === "rejected" ? null : "user-001",
      });
      expect(JSON.stringify(audit.rows)).not.toContain("test-token");
    },
  );

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

  describe("大结果 HTTP 交付与容量边界", () => {
    const note = "诊疗记录".repeat(12);
    // 第二条记录的原始行预算恰好达到上限，列信息和表格容器使标准化结果超过上限。
    const envelopeTextBytes =
      MAX_QUERY_TABLE_BYTES - Buffer.byteLength(JSON.stringify({ id: 2, content: "" }), "utf8") - 1;

    beforeAll(async () => {
      await das.initializeSchema(migrationDirectories.das);
      await das.execute({
        sql: `
          CREATE TABLE dbo.delivery_fixture (
            id INT NOT NULL PRIMARY KEY,
            department NVARCHAR(8) NOT NULL,
            phone NVARCHAR(11) NOT NULL,
            note NVARCHAR(200) NOT NULL
          );
          WITH digits AS (
            SELECT n FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) AS digit(n)
          ), numbered AS (
            SELECT 1 + a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n AS id
            FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
          )
          INSERT INTO dbo.delivery_fixture (id, department, phone, note)
          SELECT id, CASE WHEN id <= 25000 THEN N'A' ELSE N'B' END,
            N'13800138000', REPLICATE(N'诊疗记录', 12)
          FROM numbered WHERE id <= 50000;
        `,
        parameters: [],
      });
      // 大文本由隔离库视图按查询生成，分别触发 UTF-8 原始行预算和表格容器预算。
      await das.execute({
        sql: `CREATE VIEW dbo.delivery_bytes_fixture AS
          SELECT 1 AS id, REPLICATE(CAST(N'大' AS NVARCHAR(MAX)), 12 * 1024 * 1024) AS content
          UNION ALL
          SELECT 2 AS id, REPLICATE(CAST(N'a' AS NVARCHAR(MAX)), ${envelopeTextBytes}) AS content;`,
        parameters: [],
      });
      expect(
        (
          await das.execute({
            sql: "SELECT department, COUNT(*) AS row_count FROM dbo.delivery_fixture GROUP BY department ORDER BY department",
            parameters: [],
          })
        ).rows,
      ).toEqual([
        { department: "A", row_count: 25000 },
        { department: "B", row_count: 25000 },
      ]);
    });

    /** 注入本轮对象映射；请求认证、规划、驱动、结果出口和 SQL 审计均使用生产实现。 */
    async function createDeliveryApp(rowLimit: number): Promise<FastifyInstance> {
      const planner = new QueryPlanner(
        {
          findEnabledBySourceId: async (sourceId) =>
            sourceId === source.sourceId ? { ...source, rowLimit } : undefined,
        },
        {
          findQueryableBySourceIdAndObjectId: async (sourceId, objectId) =>
            sourceId === source.sourceId &&
            ["delivery_fixture", "delivery_bytes_fixture"].includes(objectId)
              ? {
                  sourceId,
                  objectId,
                  objectKind: objectId === "delivery_fixture" ? "table" : "view",
                  nativeSchemaName: "dbo",
                  nativeObjectName: objectId,
                  isDiscoverable: true,
                  isQueryable: true,
                  queryCapabilities: {},
                }
              : undefined,
        },
        // 路由中的 AuditedQueryService 已在规划前执行 JWT、整体签名和截止时间验证。
        { verify: async () => undefined },
      );
      const app = Fastify({ logger: false, genReqId: () => randomUUID() });
      registerQueryRoute(
        app,
        new QueryExecutionService(planner, {
          get: async () => {
            if (!connector) throw new Error("测试连接器尚未建立");
            return connector;
          },
        }),
        await InternalQueryVerifier.create(publicPem),
        new AuditRepository(das),
      );
      return app;
    }

    /** 科室条件代表 API 已授权并签名的对象行范围，在源关系读取时生效。 */
    function deliveryQuery(limit: number, department?: string): QueryDsl {
      return {
        type: "relational_query",
        source_id: "integration",
        from: {
          object_id: "delivery_fixture",
          alias: "f",
          ...(department === undefined
            ? {}
            : {
                filters: {
                  logic: "and",
                  items: [
                    { field: "f.department", op: "eq", data_type: "string", value: department },
                  ],
                },
              }),
        },
        select: ["id", "department", "phone", "note"].map((field) => ({
          field: "f." + field,
          as: field,
        })),
        joins: [],
        filters: { logic: "and", items: [] },
        group_by: [],
        order_by: [{ field: "f.id", direction: "asc" }],
        limit,
      };
    }

    /** 为每条真实请求签发当前有效的短时令牌与完整 DSL 签名。 */
    async function sendDeliveryQuery(app: FastifyInstance, query: QueryDsl, maskPhone = true) {
      const now = dayjs();
      const payload = createSignedRequest(
        {
          expires_at: now.add(55, "second").utcOffset(480).format("YYYY-MM-DD HH:mm:ss"),
          ...(maskPhone ? {} : { output_masks: [] }),
        },
        query,
      );
      const token = await createInternalToken({
        iat: now.unix(),
        nbf: now.unix(),
        exp: now.add(60, "second").unix(),
        jti: randomUUID(),
      });
      return app.inject({
        method: "POST",
        url: "/internal/query",
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it("五万行原始结果按驱动预算保留一万行和一条探测记录", async () => {
      const result = await driver.query("SELECT id FROM dbo.delivery_fixture ORDER BY id", [], {
        resultBudget: { maxRows: 10001, maxBytes: MAX_QUERY_TABLE_BYTES },
      });
      expect(result.rows.map((row) => row.id)).toEqual(
        Array.from({ length: 10001 }, (_, index) => index + 1),
      );
      expect(result.columns).toMatchObject([{ name: "id", dataType: "Int" }]);
    });

    it.each([
      {
        scenario: "十万上限完整交付五万行",
        sourceLimit: 100000,
        limit: 100000,
        department: undefined,
        count: 50000,
        firstId: 1,
        truncated: false,
      },
      {
        scenario: "恰好五万行上限时报告完整",
        sourceLimit: 100000,
        limit: 50000,
        department: undefined,
        count: 50000,
        firstId: 1,
        truncated: false,
      },
      {
        scenario: "A 科室授权完整交付两万五千行",
        sourceLimit: 100000,
        limit: 100000,
        department: "A",
        count: 25000,
        firstId: 1,
        truncated: false,
      },
      {
        scenario: "B 科室授权完整交付两万五千行",
        sourceLimit: 100000,
        limit: 100000,
        department: "B",
        count: 25000,
        firstId: 25001,
        truncated: false,
      },
      {
        scenario: "授权范围无匹配时返回完整空表",
        sourceLimit: 100000,
        limit: 100000,
        department: "empty",
        count: 0,
        firstId: 1,
        truncated: false,
      },
      {
        scenario: "数据源四万行上限触发截断",
        sourceLimit: 40000,
        limit: 100000,
        department: undefined,
        count: 40000,
        firstId: 1,
        truncated: true,
      },
      {
        scenario: "DSL 三万五千行上限触发截断",
        sourceLimit: 100000,
        limit: 35000,
        department: undefined,
        count: 35000,
        firstId: 1,
        truncated: true,
      },
    ])(
      "$scenario，脱敏结果与审计行数一致",
      async ({ sourceLimit, limit, department, count, firstId, truncated }) => {
        const app = await createDeliveryApp(sourceLimit);
        try {
          const response = await sendDeliveryQuery(app, deliveryQuery(limit, department));
          expect(response.statusCode).toBe(200);
          const result = queryResultSchema.parse(response.json());
          expect(result.columns).toEqual([
            { name: "id", data_type: "integer" },
            { name: "department", data_type: "string" },
            { name: "phone", data_type: "string" },
            { name: "note", data_type: "string" },
          ]);
          expect(result.rows.map((row) => row.id)).toEqual(
            Array.from({ length: count }, (_, index) => firstId + index),
          );
          expect(result.rows.every((row) => row.phone === "138********" && row.note === note)).toBe(
            true,
          );
          expect([...new Set(result.rows.map((row) => row.department))]).toEqual(
            count === 0 ? [] : department ? [department] : ["A", "B"],
          );
          expect(result.row_count).toBe(count);
          expect(result.truncated).toBe(truncated);
          expect(result.delivery).toEqual(
            truncated
              ? { status: "truncated", total_row_count: null }
              : { status: "complete", total_row_count: count },
          );
          expect(
            Buffer.byteLength(
              JSON.stringify({ columns: result.columns, rows: result.rows }),
              "utf8",
            ),
          ).toBeLessThanOrEqual(MAX_QUERY_TABLE_BYTES);
          const audit = await das.execute({
            sql: "SELECT outcome, row_count, row_filter_injected, user_id FROM dbo.query_audit_logs WHERE correlation_id = @id",
            parameters: [
              { name: "id", type: "string", value: String(response.headers["x-request-id"]) },
            ],
          });
          expect(audit.rows).toEqual([
            {
              outcome: "executed",
              row_count: String(count),
              row_filter_injected: department !== undefined,
              user_id: "user-001",
            },
          ]);
        } finally {
          await app.close();
        }
      },
    );

    it.each([
      { id: 1, boundary: "原始 UTF-8 行" },
      { id: 2, boundary: "标准化表格" },
    ])("$boundary 超出 32 MiB 时返回资源拒绝，单连接随后可再次交付", async ({ id }) => {
      if (id === 2) {
        const raw = await driver.query(
          "SELECT id, content FROM dbo.delivery_bytes_fixture WHERE id = @p0",
          [{ dataType: "integer", value: id }],
          {
            resultBudget: { maxRows: 2, maxBytes: MAX_QUERY_TABLE_BYTES },
          },
        );
        expect(raw.rows).toHaveLength(1);
        expect(Buffer.byteLength(JSON.stringify(raw.rows[0]), "utf8") + 1).toBe(
          MAX_QUERY_TABLE_BYTES,
        );
      }
      const app = await createDeliveryApp(100000);
      try {
        const query: QueryDsl = {
          type: "relational_query",
          source_id: "integration",
          from: { object_id: "delivery_bytes_fixture", alias: "b" },
          joins: [],
          select: [
            { field: "b.id", as: "id" },
            { field: "b.content", as: "content" },
          ],
          filters: {
            logic: "and",
            items: [{ field: "b.id", op: "eq", data_type: "integer", value: id }],
          },
          group_by: [],
          order_by: [],
          limit: 1,
        };
        const response = await sendDeliveryQuery(app, query, false);
        expect(response.statusCode).toBe(429);
        expect(response.json()).toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
        const audit = await das.execute({
          sql: "SELECT outcome, error_code, row_count FROM dbo.query_audit_logs WHERE correlation_id = @id",
          parameters: [
            { name: "id", type: "string", value: String(response.headers["x-request-id"]) },
          ],
        });
        expect(audit.rows).toEqual([
          { outcome: "rejected", error_code: "QUERY_LIMIT_EXCEEDED", row_count: null },
        ]);
        const recovered = await sendDeliveryQuery(app, deliveryQuery(1, "B"));
        expect(recovered.statusCode).toBe(200);
        const result = queryResultSchema.parse(recovered.json());
        expect(result.rows).toEqual([{ id: 25001, department: "B", phone: "138********", note }]);
        expect(result.delivery).toEqual({ status: "truncated", total_row_count: null });
      } finally {
        await app.close();
      }
    });
  });
});
