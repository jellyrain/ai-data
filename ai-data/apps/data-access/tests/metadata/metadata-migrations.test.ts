import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applySqlServerMigrations, loadSqlServerMigrations } from "@ai-data/metadata/sqlserver";
import type { MetadataBatchExecutor } from "@ai-data/metadata";

/** 测试目录与应用根目录下的实际 SQL 迁移文件。 */
const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

describe("DAS 元数据表迁移", () => {
  // BDD 场景：部署人员审阅独立 SQL 迁移；TDD 断言：迁移按版本文件名排序加载。
  it("按文件名顺序加载外置 SQL 迁移", () => {
    expect(
      loadSqlServerMigrations(migrationsDirectory).map((migration) => migration.fileName),
    ).toEqual(["000_schema_migrations.sql", "001_initial_das_metadata_schema.sql"]);
  });

  // BDD 场景：DAS 启动；TDD 断言：所有 SQL 文件依次交给数据库执行器。
  it("按顺序执行所有外置 SQL 迁移", async () => {
    const executedBatches: string[] = [];
    const executor: MetadataBatchExecutor = {
      async executeBatch(sql) {
        executedBatches.push(sql);
      },
    };

    await applySqlServerMigrations(executor, migrationsDirectory);

    expect(executedBatches).toHaveLength(2);
    expect(executedBatches[0]).toContain("CREATE TABLE dbo.schema_migrations");
    expect(executedBatches[1]).toContain("CREATE TABLE dbo.data_source_configs");
    expect(executedBatches[1]).toContain("CREATE TABLE dbo.query_audit_logs");
  });
});
