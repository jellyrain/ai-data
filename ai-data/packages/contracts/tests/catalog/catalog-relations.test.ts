import { describe, expect, it } from "vitest";
import { relationPublishInputSchema } from "../../src/index";

describe("关系批量发布合同", () => {
  it("创建必须明确稳定标识，省略关系不是删除", () => {
    const relation = {
      relation_id: "visit_department",
      target_object_id: "departments",
      description: "归属科室",
      column_pairs: [{ source_column: "department_id", target_column: "id" }],
      allowed_join_types: ["inner", "left"],
    };
    expect(
      relationPublishInputSchema.safeParse({
        changes: [{ action: "create", object_id: "visits", relation }],
      }).success,
    ).toBe(true);
    expect(
      relationPublishInputSchema.safeParse({
        changes: [
          {
            action: "create",
            object_id: "visits",
            relation: { ...relation, relation_id: undefined },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("更新与停用必须包含预期版本", () => {
    expect(
      relationPublishInputSchema.safeParse({
        changes: [{ action: "disable", object_id: "visits", relation_id: "r" }],
      }).success,
    ).toBe(false);
  });
});
