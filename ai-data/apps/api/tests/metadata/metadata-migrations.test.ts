import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadSqlServerMigrations } from "@ai-data/metadata/sqlserver";

/** API 应用根目录下的 SQL Server 元数据库迁移文件。 */
const migrationsDirectory = fileURLToPath(new URL("../../migrations", import.meta.url));

// 这里只验证迁移发现顺序与文件内容；数据库实际执行由迁移执行器负责。
describe("API 元数据库迁移", () => {
  it("加载版本登记表和覆盖全部业务模块的首建迁移", () => {
    const migrations = loadSqlServerMigrations(migrationsDirectory);

    expect(migrations.map((migration) => migration.fileName)).toEqual([
      "000_schema_migrations.sql",
      "001_initial_api_schema.sql",
    ]);
    expect(migrations[0]?.sql).toContain("CREATE TABLE dbo.schema_migrations");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.users");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.role_data_scopes");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.conversations");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.conversation_messages");
    expect(migrations[1]?.sql).toContain("CREATE TABLE dbo.analysis_runs");
    for (const table of [
      "approved_relations",
      "report_templates",
      "report_template_versions",
      "report_blocks",
      "report_block_versions",
      "report_executions",
      "analysis_artifacts",
      "analysis_report_contexts",
      "report_template_publications",
    ]) {
      expect(migrations[1]?.sql).toContain(`CREATE TABLE dbo.${table}`);
    }
  });
});
