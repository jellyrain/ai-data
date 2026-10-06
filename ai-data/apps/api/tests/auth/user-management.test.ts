import { describe, expect, it, vi } from "vitest";
import type { MetadataQueryExecutor, MetadataStatement } from "@ai-data/metadata";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";

describe("管理员创建与部门比较更新", () => {
  it("提交不可分配角色时在事务内拒绝，尚未插入用户", async () => {
    const writes: MetadataStatement[] = [];
    const execute: MetadataQueryExecutor["execute"] = async (statement) => {
      if (statement.sql.includes("INSERT INTO dbo.users")) writes.push(statement);
      return { rows: [], rowsAffected: [] } as never;
    };
    const transaction = vi.fn(
      async (operation: (executor: MetadataQueryExecutor) => Promise<unknown>) =>
        operation({ execute }),
    );
    const database = { execute, transaction };
    const repository = new SqlAuthRepository(database);
    await expect(
      repository.createUser({
        id: "new",
        organizationId: "org",
        username: "new",
        displayName: "新用户",
        passwordHash: "test",
        roleIds: ["foreign"],
        exceptionDataScopeIds: [],
        assignmentAuthority: { canAssignPrivileged: false },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });
  it("部门基准冲突返回明确业务错误", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ updated: false, conflict: true }],
      rowsAffected: [],
    }));
    const repository = new SqlAuthRepository({ execute } as MetadataQueryExecutor);
    await expect(repository.updateUserDepartments("member", "org", ["A"], 2)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });
});
