import { describe, expect, it } from "vitest";
import {
  objectPermissionInputSchema,
  columnPermissionInputSchema,
  rowPolicyInputSchema,
  policyListQuerySchema,
  policyVersionParamsSchema,
  policyVersionSchema,
} from "../../src/catalog-admin/catalog-admin-schemas";

const base = { source_id: "clinical", role_id: "role-a", object_id: "visit", effect: "allow" };

// 前提：管理接口接收浏览器输入。操作：提交权限字段、版本和分页。预期：共享授权约束与管理端资源边界共同生效。
describe("目录管理输入合同", () => {
  it.each([
    [objectPermissionInputSchema, base],
    [columnPermissionInputSchema, { ...base, column: "department", operations: ["select"] }],
    [
      rowPolicyInputSchema,
      { ...base, condition: { field: "department", op: "eq", value: "产科" } },
    ],
  ])("接受合法策略并拒绝缺失角色和未知组织字段", (schema, input) => {
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, role_id: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...input, organization_id: "foreign" }).success).toBe(false);
    expect(schema.safeParse({ ...input, expected_version: -1 }).success).toBe(false);
  });

  it("权限对象和列名拒绝注入片段", () => {
    expect(
      objectPermissionInputSchema.safeParse({ ...base, object_id: "visit; DELETE FROM users" })
        .success,
    ).toBe(false);
    expect(columnPermissionInputSchema.safeParse({ ...base, column: "phone --" }).success).toBe(
      false,
    );
  });

  it("字段拒绝决定不接受局部操作，行条件保持取值互斥约束", () => {
    expect(
      columnPermissionInputSchema.safeParse({
        ...base,
        column: "department",
        effect: "deny",
        operations: ["select"],
      }).success,
    ).toBe(false);
    expect(
      rowPolicyInputSchema.safeParse({
        ...base,
        condition: {
          field: "department",
          op: "eq",
          value: "产科",
          value_from: "permission_context.department_ids",
        },
      }).success,
    ).toBe(false);
  });

  it("版本及分页取值具备明确上限和默认值", () => {
    expect(policyListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(policyListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(policyListQuerySchema.safeParse({ before_version: 0 }).success).toBe(false);
    expect(
      policyVersionParamsSchema.safeParse({ sourceId: "clinical", roleId: "role-a", version: "1" })
        .success,
    ).toBe(true);
    expect(
      policyVersionParamsSchema.safeParse({ sourceId: "clinical", roleId: "role-a", version: "0" })
        .success,
    ).toBe(false);
  });

  it("持久化版本要求完整快照和真实日期", () => {
    const permission = { role_id: "role-a", object_id: "visit", effect: "allow" };
    const record = {
      organization_id: "org",
      source_id: "clinical",
      role_id: "role-a",
      version: 1,
      changed_by: "admin",
      changed_at: "2026-09-14 10:00:00",
      summary: { kind: "object_permission", object_id: "visit", effect: "allow" },
      change: { kind: "object_permission", permission },
      snapshot: { object_permissions: [permission], column_permissions: [], row_policies: [] },
    };
    expect(policyVersionSchema.safeParse(record).success).toBe(true);
    expect(policyVersionSchema.safeParse({ ...record, snapshot: undefined }).success).toBe(false);
    expect(
      policyVersionSchema.safeParse({ ...record, changed_at: "2026-02-30 10:00:00" }).success,
    ).toBe(false);
    expect(policyVersionSchema.safeParse({ ...record, actor: "spoof" }).success).toBe(false);
  });
});
