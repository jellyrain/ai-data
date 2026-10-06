import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { SqlAuthRepository } from "../../src/auth/sql-auth-repository";
import { SqlUserAdminReader } from "../../src/auth/sql-user-admin-reader";
import { SqlCatalogRepository } from "../../src/catalog/sql-catalog-repository";
import { SqlCatalogAdminRepository } from "../../src/catalog-admin/sql-catalog-admin-repository";
import { context } from "../support/api-fixtures";
/** 仅在本轮随机隔离元数据库验证事务、组织范围与授权版本。 */
describe("SQL Server 管理用户与当前策略", () => {
  const name = "ai_data_management_test_" + randomUUID().replaceAll("-", "");
  let admin: SqlServerMetadataDatabase,
    database: SqlServerMetadataDatabase,
    users: SqlAuthRepository,
    reader: SqlUserAdminReader,
    created = false;
  beforeAll(async () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../config/api.config.json", import.meta.url)), "utf8"),
    ) as Record<string, unknown>;
    const config = apiConfigSchema.shape.metadata_sqlserver.parse(raw.metadata_sqlserver);
    admin = await SqlServerMetadataDatabase.connect({ ...config, database: "master" });
    await admin.execute({ sql: `CREATE DATABASE [${name}]`, parameters: [] });
    created = true;
    database = await SqlServerMetadataDatabase.connect({ ...config, database: name });
    await database.initializeSchema(fileURLToPath(new URL("../../migrations", import.meta.url)));
    users = new SqlAuthRepository(database);
    reader = new SqlUserAdminReader(database);
    await users.ensureBootstrapAdmin({
      userId: "manager",
      organizationId: "org",
      organizationCode: "management-test",
      organizationName: "管理测试",
      username: "manager",
      displayName: "管理测试",
      passwordHash: "fixture-hash",
    });
    await database.execute({
      sql: "INSERT INTO dbo.organizations(id,code,name) VALUES('other','other',N'其他组织'); INSERT INTO dbo.roles(id,code,name) VALUES('reader','reader',N'读者'),('privileged','custom-manager',N'管理员'),('foreign','foreign',N'外部角色'); INSERT INTO dbo.permissions(id,code,name) VALUES('custom-manage','models:manage',N'模型管理'); INSERT INTO dbo.role_permissions VALUES('privileged','custom-manage'); INSERT INTO dbo.data_scopes(id,resource,field,operator,value) VALUES('own-scope','visits','department','eq','D01'),('foreign-scope','visits','department','eq','D99')",
      parameters: [],
    });
    await users.createUser({
      id: "seed",
      organizationId: "org",
      username: "seed",
      displayName: "种子用户",
      passwordHash: "fixture-hash",
      roleIds: ["reader", "privileged"],
      exceptionDataScopeIds: ["own-scope"],
    });
    await users.createUser({
      id: "foreign-seed",
      organizationId: "other",
      username: "other-seed",
      displayName: "外部种子",
      passwordHash: "fixture-hash",
      roleIds: ["foreign"],
      exceptionDataScopeIds: ["foreign-scope"],
    });
  });
  afterAll(async () => {
    await database?.close();
    try {
      if (created) {
        if (!/^ai_data_management_test_[a-f0-9]{32}$/.test(name)) throw new Error("隔离库名称无效");
        await admin.execute({ sql: `DROP DATABASE [${name}]`, parameters: [] });
      }
    } finally {
      await admin?.close();
    }
  });
  it("组织内选项过滤特权角色和外部绑定", async () => {
    const options = await reader.options("org", false);
    expect(options.roles.map((role) => role.id)).toEqual(["reader"]);
    expect(options.exception_data_scopes.map((scope) => scope.id)).toEqual(["own-scope"]);
    expect((await reader.options("org", true)).roles.some((role) => role.id === "privileged")).toBe(
      true,
    );
    await expect(reader.authorization("org", "foreign-seed")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("不可分配角色与例外均拒绝创建，合法绑定整体提交", async () => {
    const input = {
      id: "new",
      organizationId: "org",
      username: "new",
      displayName: "新用户",
      passwordHash: "fixture-hash",
      roleIds: ["reader"],
      exceptionDataScopeIds: ["own-scope"],
      assignmentAuthority: { canAssignPrivileged: false },
    };
    for (const changed of [
      { roleIds: ["privileged"] },
      { roleIds: ["foreign"] },
      { exceptionDataScopeIds: ["foreign-scope"] },
    ])
      await expect(users.createUser({ ...input, ...changed })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    expect(await users.findUserById("new")).toBeNull();
    await users.createUser(input);
    expect(await reader.authorization("org", "new")).toMatchObject({
      authorization_version: 1,
      roles: [{ id: "reader" }],
      exception_data_scopes: [{ id: "own-scope" }],
    });
  });
  it("写绑定失败回滚用户，部门同基准并发只有一个提交", async () => {
    await expect(
      users.createUser({
        id: "rollback",
        organizationId: "org",
        username: "rollback",
        displayName: "回滚",
        passwordHash: "fixture-hash",
        roleIds: ["reader", "reader"],
        exceptionDataScopeIds: [],
      }),
    ).rejects.toThrow();
    expect(await users.findUserById("rollback")).toBeNull();
    const results = await Promise.allSettled([
      users.updateUserDepartments("new", "org", ["D01"], 1),
      users.updateUserDepartments("new", "org", ["D02"], 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
    expect((await reader.authorization("org", "new")).authorization_version).toBe(2);
    await users.updateUserDepartments("new", "org", [], 2);
    expect((await reader.authorization("org", "new")).department_ids).toEqual([]);
  });
  it("无历史规则从实际权限表读取，后续版本与快照一致", async () => {
    const permissions = new SqlCatalogRepository(database),
      policies = new SqlCatalogAdminRepository(database);
    await permissions.saveObjectPermission("clinical", {
      role_id: "reader",
      object_id: "visits",
      effect: "allow",
    });
    expect(await policies.currentState("org", "clinical", "reader")).toMatchObject({
      version: 0,
      snapshot: { object_permissions: [{ object_id: "visits", effect: "allow" }] },
    });
    const saved = await policies.saveChange(
      { ...context, userId: "manager", organizationId: "org" },
      "clinical",
      {
        kind: "object_permission",
        permission: { role_id: "reader", object_id: "visits", effect: "deny" },
      },
      0,
    );
    expect(await policies.currentState("org", "clinical", "reader")).toMatchObject({
      version: saved.version,
      snapshot: { object_permissions: [{ effect: "deny" }] },
    });
    await expect(
      policies.saveChange(
        { ...context, userId: "manager", organizationId: "org" },
        "clinical",
        {
          kind: "object_permission",
          permission: { role_id: "reader", object_id: "visits", effect: "allow" },
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
