import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { MetadataBatchExecutor, MetadataMigration } from "../metadata-types";

/** 从外置目录加载 SQL Server 元数据库迁移文件。 */
function loadSqlServerMigrations(migrationsDirectory: string): MetadataMigration[] {
  const migrationFiles = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (migrationFiles.length === 0) {
    throw new Error(`SQL Server 元数据库迁移目录中没有 .sql 文件: ${migrationsDirectory}`);
  }

  return migrationFiles.map((fileName) => ({
    fileName,
    sql: readFileSync(join(migrationsDirectory, fileName), "utf8"),
  }));
}

/** 按文件名顺序执行所有 SQL Server 元数据库迁移。 */
async function applySqlServerMigrations(
  executor: MetadataBatchExecutor,
  migrationsDirectory: string,
): Promise<void> {
  for (const migration of loadSqlServerMigrations(migrationsDirectory)) {
    await executor.executeBatch(migration.sql);
  }
}

export { applySqlServerMigrations, loadSqlServerMigrations };
