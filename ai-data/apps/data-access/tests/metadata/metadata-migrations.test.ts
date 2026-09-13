import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applySqlServerMigrations, loadSqlServerMigrations } from "@ai-data/metadata/sqlserver";
import type { MetadataBatchExecutor } from "@ai-data/metadata";

/** 测试目录与应用根目录下的实际 SQL 迁移文件。 */
const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

// 加载应用实际发布的 SQL 文件，以记录批次的执行器检查顺序；本组不执行数据库 DDL。
describe("DAS 元数据表迁移", () => {
  it("按文件名顺序加载外置 SQL 迁移", () => {
    expect(
      loadSqlServerMigrations(migrationsDirectory).map((migration) => migration.fileName),
    ).toEqual([
      "000_schema_migrations.sql",
      "001_initial_das_metadata_schema.sql",
      "002_procedure_definitions.sql",
    ]);
  });

  it("按顺序执行所有外置 SQL 迁移", async () => {
    const executedBatches: string[] = [];
    const executor: MetadataBatchExecutor = {
      async executeBatch(sql) {
        executedBatches.push(sql);
      },
    };

    await applySqlServerMigrations(executor, migrationsDirectory);

    expect(executedBatches).toHaveLength(3);
    expect(executedBatches[0]).toContain("CREATE TABLE dbo.schema_migrations");
    expect(executedBatches[1]).toContain("CREATE TABLE dbo.data_source_configs");
    expect(executedBatches[1]).toContain("CREATE TABLE dbo.query_audit_logs");
    expect(executedBatches[2]).toContain("ADD procedure_definition_json NVARCHAR(MAX) NULL");
  });
});
