import { describe, expect, it, vi } from "vitest";
import type { MetadataQueryExecutor, MetadataStatement } from "@ai-data/metadata";

import { SqlCatalogAdminRepository } from "../../src/catalog-admin/sql-catalog-admin-repository";
import type { PolicyVersion } from "../../src/catalog-admin/catalog-admin-types";
import type { AuthContext } from "../../src/auth/auth-types";

const context: AuthContext = {
  userId: "admin",
  organizationId: "hospital-a",
  sessionId: "session",
  roles: ["system_admin"],
  permissions: [],
  dataPolicies: [],
};
const permission = { role_id: "role-a", object_id: "visit", effect: "allow" as const };
const existing: PolicyVersion = {
  organization_id: "hospital-a",
  source_id: "clinical",
  role_id: "role-a",
  version: 3,
  changed_by: "admin",
  changed_at: "2026-09-14 10:00:00",
  summary: { kind: "object_permission", object_id: "visit", effect: "allow" },
  change: { kind: "object_permission", permission },
  snapshot: { object_permissions: [permission], column_permissions: [], row_policies: [] },
};

/** 事务替身仅在回调完成时发布写入，失败时丢弃该事务积累的语句。 */
function setup() {
  const committed: MetadataStatement[] = [];
  const reads: MetadataStatement[] = [];
  let hasRole = true;
  let failsVersionInsert = false;
  const transactionStarted = vi.fn();
  const execute: MetadataQueryExecutor["execute"] = async (statement) => {
    reads.push(statement);
    if (statement.sql.includes("AS role_code"))
      return {
        rows: hasRole
          ? [{ role_id: "role-a", role_code: "clinician", permission_code: "query:read" }]
          : [],
        rowsAffected: [],
      } as never;
    if (statement.sql.includes("dbo.role_data_scopes"))
      return {
        rows: [{ resource: "visit", field: "department", operator: "in", value: "产科,内科" }],
        rowsAffected: [],
      } as never;
    if (statement.sql.includes("SELECT TOP (1) version"))
      return { rows: [{ version: 4 }], rowsAffected: [] } as never;
    if (statement.sql.includes("SELECT") && statement.sql.includes("record_json"))
      return { rows: [{ record_json: JSON.stringify(existing) }], rowsAffected: [] } as never;
    if (statement.sql.includes("SELECT role_id, object_id, effect"))
      return { rows: [permission], rowsAffected: [] } as never;
    if (statement.sql.includes("SELECT role_id, object_id, column_name"))
      return {
        rows: [{ ...permission, column_name: "department", operations_json: null }],
        rowsAffected: [],
      } as never;
    if (statement.sql.includes("INSERT INTO dbo.catalog_policy_versions") && failsVersionInsert)
      throw new Error("版本写入失败");
    return { rows: [], rowsAffected: [1] } as never;
  };
  const database = {
    execute,
    async transaction<T>(operation: (executor: MetadataQueryExecutor) => Promise<T>): Promise<T> {
      transactionStarted();
      const pending: MetadataStatement[] = [];
      const result = await operation({
        execute: async (statement) => {
          const output = await execute(statement);
          if (/^\s*(UPDATE|INSERT)/.test(statement.sql)) pending.push(statement);
          return output as never;
        },
      });
      committed.push(...pending);
      return result;
    },
  };
  return {
    repository: new SqlCatalogAdminRepository(database),
    transactionStarted,
    committed,
    reads,
    missingRole: () => {
      hasRole = false;
    },
    failVersion: () => {
      failsVersionInsert = true;
    },
  };
}

// 前提：源当前版本为 4，目标角色版本为 3。操作：写入一项策略。预期：发布源版本 5 并保存完整角色快照，冲突或失败时原子回滚。
describe("目录策略事务仓储", () => {
  it("当前策略从实际权限表读回，而不把上次版本快照当作当前规则", async () => {
    const { repository, transactionStarted } = setup();
    const state = await repository.currentState(context.organizationId, "clinical", "role-a");
    expect(state.version).toBe(3);
    expect(state.snapshot.column_permissions).toEqual([{ ...permission, column: "department" }]);
    expect(transactionStarted).toHaveBeenCalledOnce();
  });
  it("策略写入和完整快照及审计摘要在同一事务中提交", async () => {
    const { repository, transactionStarted, committed } = setup();
    const result = await repository.saveChange(
      context,
      "clinical",
      { kind: "column_permission", permission: { ...permission, column: "department" } },
      3,
    );
    expect(transactionStarted).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      version: 5,
      changed_by: "admin",
      role_id: "role-a",
      summary: { kind: "column_permission", column: "department" },
      snapshot: {
        object_permissions: [permission],
        column_permissions: [{ ...permission, column: "department" }],
      },
    });
    const audit = committed.find((statement) =>
      statement.sql.includes("INSERT INTO dbo.catalog_policy_versions"),
    );
    expect(
      JSON.parse(String(audit?.parameters.find((item) => item.name === "record_json")?.value)),
    ).toEqual(result);
    expect(committed.some((statement) => statement.sql.includes("role_column_permissions"))).toBe(
      true,
    );
  });

  it("省略字段操作时以数据库 NULL 保存默认操作范围", async () => {
    const { repository, committed } = setup();
    await repository.saveChange(context, "clinical", {
      kind: "column_permission",
      permission: { ...permission, column: "department" },
    });
    expect(
      committed.find((statement) => statement.sql.includes("role_column_permissions"))?.parameters,
    ).toContainEqual({ name: "operations_json", type: "string", value: null });
  });

  it("期望版本过期时拒绝变更且事务没有提交策略", async () => {
    const { repository, committed } = setup();
    await expect(
      repository.saveChange(context, "clinical", { kind: "object_permission", permission }, 2),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(committed).toEqual([]);
  });

  it("事务内再次校验角色归属，拒绝已变化的组织范围", async () => {
    const { repository, committed, missingRole, reads } = setup();
    missingRole();
    await expect(
      repository.saveChange(context, "clinical", { kind: "object_permission", permission }, 3),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(committed).toEqual([]);
    const ownership = reads.find((statement) => statement.sql.includes("AS role_code"));
    expect(ownership?.sql).toContain("NOT EXISTS");
    expect(ownership?.sql).toContain("organization_id <> @organization_id");
    expect(ownership?.sql).toContain("HOLDLOCK");
    expect(ownership?.parameters).toContainEqual({
      name: "organization_id",
      type: "string",
      value: "hospital-a",
    });
  });

  it("审计版本插入失败时策略写入一起回滚", async () => {
    const { repository, committed, failVersion } = setup();
    failVersion();
    await expect(
      repository.saveChange(context, "clinical", { kind: "object_permission", permission }, 3),
    ).rejects.toThrow("版本写入失败");
    expect(committed).toEqual([]);
  });

  it("指定角色继承功能权限和角色数据范围", async () => {
    const { repository, reads } = setup();
    await expect(repository.loadRoleAuthorization("hospital-a", "role-a")).resolves.toEqual({
      roleIds: ["role-a"],
      roles: ["clinician"],
      permissions: ["query:read"],
      dataPolicies: [
        {
          resource: "visit",
          field: "department",
          operator: "in",
          value: ["产科", "内科"],
          mandatory: true,
        },
      ],
      permissionContext: { department_ids: [] },
    });
    expect(
      reads.find((statement) => statement.sql.includes("dbo.role_data_scopes"))?.parameters,
    ).toContainEqual({ name: "role_id", type: "string", value: "role-a" });
  });

  it("版本列表使用组织、角色、源和游标并只返回摘要", async () => {
    const { repository, reads } = setup();
    const items = await repository.listVersions("hospital-a", "clinical", "role-a", 20, 5);
    expect(items).toEqual([expect.objectContaining({ version: 3, changed_by: "admin" })]);
    expect(items[0]).not.toHaveProperty("snapshot");
    const statement = reads.at(-1)!;
    expect(statement.sql).toContain("TOP (@limit)");
    expect(statement.parameters).toEqual(
      expect.arrayContaining([
        { name: "organization_id", type: "string", value: "hospital-a" },
        { name: "role_id", type: "string", value: "role-a" },
        { name: "before_version", type: "integer", value: 5 },
      ]),
    );
  });
});
