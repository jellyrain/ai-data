import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySqlServerMigrations,
  loadSqlServerMigrations,
} from "../../src/sqlserver/sqlserver-migrations";

const directories: string[] = [];
/** 每个场景生成独立迁移目录，使用文件系统验证加载与排序规则。 */
function directory(): string {
  const result = mkdtempSync(join(tmpdir(), "ai-data-migrations-"));
  directories.push(result);
  return result;
}
afterEach(() => {
  for (const target of directories.splice(0)) {
    if (dirname(resolve(target)) !== resolve(tmpdir())) throw new Error("临时目录范围无效");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("SQL Server 迁移文件", () => {
  it("只加载 SQL 文件并按版本文件名排序", () => {
    const target = directory();
    writeFileSync(join(target, "020_second.sql"), "SELECT 2;", "utf8");
    writeFileSync(join(target, "010_first.sql"), "SELECT N'中文';", "utf8");
    writeFileSync(join(target, "README.md"), "说明", "utf8");
    mkdirSync(join(target, "030_directory.sql"));
    expect(loadSqlServerMigrations(target)).toEqual([
      { fileName: "010_first.sql", sql: "SELECT N'中文';" },
      { fileName: "020_second.sql", sql: "SELECT 2;" },
    ]);
  });

  it("空迁移目录明确报告配置问题", () => {
    expect(() => loadSqlServerMigrations(directory())).toThrow("没有 .sql 文件");
  });

  it("等待前一批次完成后执行下一批次", async () => {
    const target = directory();
    writeFileSync(join(target, "001.sql"), "first");
    writeFileSync(join(target, "002.sql"), "second");
    let finishFirst!: () => void;
    const first = new Promise<void>((resolveFirst) => {
      finishFirst = resolveFirst;
    });
    const executeBatch = vi.fn(async (sql: string) => {
      if (sql === "first") await first;
    });
    const pending = applySqlServerMigrations({ executeBatch }, target);
    expect(executeBatch.mock.calls).toEqual([["first"]]);
    finishFirst();
    await pending;
    expect(executeBatch.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("失败时停止后续迁移，并保留原始异常", async () => {
    const target = directory();
    for (const name of ["001", "002", "003"]) writeFileSync(join(target, name + ".sql"), name);
    const failure = new Error("第二批次失败");
    const executeBatch = vi.fn(async (sql: string) => {
      if (sql === "002") throw failure;
    });
    await expect(applySqlServerMigrations({ executeBatch }, target)).rejects.toBe(failure);
    expect(executeBatch.mock.calls).toEqual([["001"], ["002"]]);
  });
});
