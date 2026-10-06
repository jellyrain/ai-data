import { describe, it, expect } from "vitest";
import { managedObjectCapabilities } from "../../src/data-sources/managed-object-capabilities";
import { manageableSourceObjectSchema } from "@ai-data/contracts";
const object = manageableSourceObjectSchema.parse({
  object_id: "table.dbo.visits",
  kind: "table",
  native_object_name: "visits",
  columns: [{ name: "department_id", data_type: "string", nullable: false }],
  query_capabilities: {
    filter_conditions: [
      { name: "department_id", data_type: "string", allowed_ops: ["eq"], required: true },
    ],
    sortable_fields: ["department_id"],
  },
});
describe("管理能力收窄", () => {
  it("必填过滤不能通过空数组删除", () =>
    expect(() => managedObjectCapabilities(object, { filter_conditions: [] })).toThrow("缺少必填"));
  it("显式空排序能力保留，继承必填过滤", () =>
    expect(managedObjectCapabilities(object, { sortable_fields: [] })).toEqual({
      ...object.query_capabilities,
      sortable_fields: [],
    }));
  it("字段与操作不得超出连接器声明", () =>
    expect(() =>
      managedObjectCapabilities(object, {
        filter_conditions: [
          { name: "department_id", data_type: "string", allowed_ops: ["in"], required: true },
        ],
      }),
    ).toThrow());
});
