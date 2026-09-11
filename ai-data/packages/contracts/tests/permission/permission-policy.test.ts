import { describe, expect, it } from "vitest";

import {
  columnPermissionSchema,
  rowConditionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "../../src/permission/permission-policy";

describe("权限策略合同", () => {
  // BDD 场景：角色配置表、列和 API 权限计算上下文行策略；TDD 断言：三类合法策略均可解析。
  it("接受表权限、列权限和行权限", () => {
    expect(
      tablePermissionSchema.parse({
        role_id: "gyne_director",
        object_id: "clinical.surgery_record",
        effect: "allow",
      }),
    ).toMatchObject({ effect: "allow" });

    expect(
      columnPermissionSchema.parse({
        role_id: "gyne_director",
        object_id: "clinical.surgery_record",
        column: "patient_name",
        effect: "deny",
      }),
    ).toMatchObject({ column: "patient_name" });

    expect(
      columnPermissionSchema.parse({
        role_id: "analyst",
        object_id: "clinical.surgery_record",
        column: "patient_phone",
        effect: "allow",
        operations: ["filter"],
      }),
    ).toMatchObject({ operations: ["filter"] });

    expect(
      rowPolicySchema.parse({
        role_id: "gyne_director",
        object_id: "clinical.surgery_record",
        effect: "allow",
        condition: {
          field: "performing_dept_id",
          op: "in",
          value_from: "permission_context.department_ids",
        },
      }),
    ).toMatchObject({ role_id: "gyne_director" });
  });

  // BDD 场景：普通比较缺少或重复配置值来源；TDD 断言：value 与 value_from 必须二选一。
  it("要求普通比较条件恰好有一个值来源", () => {
    expect(() => rowConditionSchema.parse({ field: "status", op: "eq" })).toThrow();

    expect(() =>
      rowConditionSchema.parse({
        field: "status",
        op: "eq",
        value: "completed",
        value_from: "permission_context.status",
      }),
    ).toThrow();
  });

  // BDD 场景：使用 is_null 或 not_null 判断空值；TDD 断言：空值操作不能携带比较值。
  it("不允许空值判断携带 value", () => {
    expect(() =>
      rowConditionSchema.parse({ field: "discharged_at", op: "is_null", value: null }),
    ).toThrow();

    expect(rowConditionSchema.parse({ field: "discharged_at", op: "not_null" })).toMatchObject({
      op: "not_null",
    });
  });

  it("接受 between 行策略并拒绝错误范围长度", () => {
    expect(
      rowConditionSchema.parse({
        field: "visit_date",
        op: "between",
        value: ["2026-01-01", "2026-01-31"],
      }),
    ).toMatchObject({ op: "between" });

    expect(() =>
      rowConditionSchema.parse({ field: "visit_date", op: "between", value: "2026-01-01" }),
    ).toThrow();
  });

  // BDD 场景：策略包含 SQL 片段或未定义字段；TDD 断言：权限合同必须阻断注入和越权字段。
  it("拒绝不安全对象引用和未知策略字段", () => {
    expect(() =>
      tablePermissionSchema.parse({
        role_id: "analyst",
        object_id: "clinical.visit;DROP TABLE users",
        effect: "allow",
      }),
    ).toThrow();

    expect(() =>
      tablePermissionSchema.parse({
        role_id: "analyst",
        object_id: "clinical.visit",
        effect: "allow",
        can_write: true,
      }),
    ).toThrow();
  });
});
