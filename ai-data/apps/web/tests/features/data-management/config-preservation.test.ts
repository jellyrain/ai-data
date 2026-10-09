import { describe, it, expect } from "vitest";
import { adminDatasetDetailSchema, managedSourceObjectSchema } from "@ai-data/contracts";
import {
  catalogDraft,
  catalogInput,
} from "../../../src/features/data-management/stores/catalog-draft";
import { objectSelection } from "../../../src/features/data-management/stores/object-selection";
describe("完整配置编辑保持", () => {
  it("可视化草稿回存保持参数省略、空集合、默认零值和权限绑定", () => {
    const detail = adminDatasetDetailSchema.parse({
      dataset: {
        source_id: "clinical",
        object_id: "visits",
        name: "查询",
        kind: "stored_procedure",
        columns: [],
      },
      config_version: 4,
      config: {
        source_id: "clinical",
        object_id: "visits",
        query_capabilities: { filter_conditions: [] },
        query_parameter_policies: [
          { name: "amount", default_value: 0, required: false },
          { name: "department_id" },
        ],
        query_permission_bindings: [
          { field: "department_id", parameter: "department_id", operator: "eq" },
        ],
      },
    });
    const draft = catalogDraft(detail);
    draft.config.business_description = "新版说明";
    expect(catalogInput(draft)).toEqual({ ...detail.config, business_description: "新版说明" });
    draft.config.query_permission_bindings = [];
    expect(catalogInput(draft).query_permission_bindings).toEqual([]);
    expect(detail.config!.query_permission_bindings).toHaveLength(1);
  });
  it("修改说明保持关系和显式空能力，清空高级段恢复继承", () => {
    const detail = adminDatasetDetailSchema.parse({
      dataset: {
        source_id: "clinical",
        object_id: "visits",
        name: "门诊",
        kind: "table",
        columns: [],
      },
      config_version: 3,
      config: {
        source_id: "clinical",
        object_id: "visits",
        query_capabilities: { sortable_fields: [] },
        approved_relations: [
          {
            target_object_id: "departments",
            description: "就诊科室",
            column_pairs: [{ source_column: "department_id", target_column: "id" }],
          },
        ],
      },
    });
    const draft = catalogDraft(detail);
    draft.config.business_description = "就诊明细";
    expect(catalogInput(draft).approved_relations).toEqual(detail.config!.approved_relations);
    expect(catalogInput(draft).query_capabilities).toEqual({ sortable_fields: [] });
    draft.config.query_capabilities = undefined;
    expect(catalogInput(draft).query_capabilities).toBeUndefined();
  });
  it("白名单编辑保留逻辑别名、真实映射和隐藏开关", () => {
    const item = managedSourceObjectSchema.parse({
      source_id: "clinical",
      object_id: "visits",
      object_kind: "table",
      native_schema_name: "dbo",
      native_object_name: "raw_visit",
      is_discoverable: false,
      is_queryable: false,
      query_capabilities: { sortable_fields: [] },
    });
    expect(objectSelection(item)).toEqual({
      object_id: "visits",
      discovered_object_id: "table.dbo.raw_visit",
      is_discoverable: false,
      is_queryable: false,
      query_capabilities: { sortable_fields: [] },
    });
  });
});
