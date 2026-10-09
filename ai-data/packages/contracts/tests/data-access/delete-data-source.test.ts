import { describe, expect, it } from "vitest";
import { deleteDataSourceSchema } from "../../src/data-access/data-source-management";
describe("数据源删除合同", () => {
  it("必须携带配置及白名单修订，拒绝额外删除范围", () => {
    const input = {
      source_id: "clinical",
      expected_revision: "a".repeat(64),
      expected_objects_revision: "b".repeat(64),
    };
    expect(deleteDataSourceSchema.parse(input)).toEqual(input);
    expect(
      deleteDataSourceSchema.safeParse({ ...input, expected_objects_revision: undefined }).success,
    ).toBe(false);
    expect(deleteDataSourceSchema.safeParse({ ...input, delete_database: true }).success).toBe(
      false,
    );
  });
});
