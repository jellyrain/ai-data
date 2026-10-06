import { describe, expect, it } from "vitest";
import * as contracts from "../../src/index";

describe("用户管理表单合同", () => {
  it("只接受公开创建字段并拒绝重复绑定及越界密码", () => {
    const input = {
      username: "doctor",
      display_name: "医生",
      password: "test-password",
      role_ids: ["clinical"],
      exception_data_scope_ids: [],
    };
    expect(contracts.createManagedUserSchema.safeParse(input).success).toBe(true);
    for (const extra of [
      { role_ids: ["a", "a"] },
      { organization_id: "other" },
      { password: "short" },
    ])
      expect(contracts.createManagedUserSchema.safeParse({ ...input, ...extra }).success).toBe(
        false,
      );
  });
  it("部门空集合可撤回范围，旧并发基准必须为有效整数", () => {
    expect(
      contracts.managedDepartmentsInputSchema.safeParse({
        department_ids: [],
        expected_authorization_version: 3,
      }).success,
    ).toBe(true);
    expect(
      contracts.managedDepartmentsInputSchema.safeParse({ department_ids: ["A", "A"] }).success,
    ).toBe(false);
    expect(
      contracts.managedDepartmentsInputSchema.safeParse({
        department_ids: [],
        expected_authorization_version: 0,
      }).success,
    ).toBe(false);
  });
});
