import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSqlServerMigrations } from "@ai-data/metadata/sqlserver";

/** API 应用根目录下的 SQL Server 元数据库迁移文件。 */
const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

describe("API 元数据库迁移", () => {
  // BDD 场景：部署 API 元数据库；TDD 断言：基础迁移文件可被共享迁移执行器发现。
  it("加载 API 自己的基础迁移", () => {
    const migrations = loadSqlServerMigrations(migrationsDirectory);

    expect(migrations.map((migration) => migration.fileName)).toEqual([
      "000_schema_migrations.sql",
      "001_initial_auth_schema.sql",
    ]);
    expect(migrations[0]?.sql).toContain("CREATE TABLE dbo.schema_migrations");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.users");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.role_data_scopes");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.conversations");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.conversation_messages");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.analysis_runs");
  });
});
