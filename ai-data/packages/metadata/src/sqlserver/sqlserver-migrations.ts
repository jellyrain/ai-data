import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { MetadataBatchExecutor, MetadataMigration } from "../metadata-types";

/** 从应用发布目录读取 SQL 迁移；按文件名排序，因此版本前缀需保持可排序格式。 */
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

/**
 * 顺序提交每个迁移文件为独立批次，失败时停止后续迁移。
 * 每次启动都会读取全部文件；版本跳过与事务范围由各 SQL 文件自身控制。
 */
async function applySqlServerMigrations(
  executor: MetadataBatchExecutor,
  migrationsDirectory: string,
): Promise<void> {
  for (const migration of loadSqlServerMigrations(migrationsDirectory)) {
    await executor.executeBatch(migration.sql);
  }
}

export { applySqlServerMigrations, loadSqlServerMigrations };
