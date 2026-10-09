import { describe, expect, it } from "vitest";
import {
  manageableSourceObjectSchema,
  sourceObjectSelectionRequestSchema,
  apiDatasetConfigSchema,
  queryDslSchema,
  outputMaskSchema,
  metricDefinitionSchema,
  reportDefinitionSchema,
} from "../../src/index";

const object_id = "table.dbo.temp_t_yp0_drug_list_CT";
const fields = ["__$start_lsn", "__$end_lsn", "__$seqval", "__$operation", "__$update_mask"];
const query = {
  type: "relational_query",
  source_id: "hdr",
  from: { object_id, alias: "变更" },
  select: [{ field: "变更.__$operation", as: "操作$类型" }],
};

describe("含美元符号的数据库字段", () => {
  it("发现结果和白名单保留 hdr 变更表的五个字段", () => {
    const columns = fields.map((name) => ({ name, data_type: "integer", nullable: true }));
    expect(
      manageableSourceObjectSchema.parse({
        object_id,
        kind: "table",
        native_schema_name: "dbo",
        native_object_name: "temp_t_yp0_drug_list_CT",
        columns,
      }).columns,
    ).toEqual(columns);
    expect(
      sourceObjectSelectionRequestSchema.parse({
        source_id: "hdr",
        objects: [{ object_id }],
      }).objects[0].object_id,
    ).toBe(object_id);
    expect(
      apiDatasetConfigSchema.parse({
        source_id: "hdr",
        object_id,
        unique_keys: [["__$seqval"]],
        column_policies: [{ field: "__$update_mask", default_masking: { type: "none" } }],
        approved_relations: [
          {
            target_object_id: "view.dbo.变更$明细",
            description: "变更序列",
            column_pairs: [{ source_column: "__$seqval", target_column: "__$seqval" }],
          },
        ],
      }).unique_keys,
    ).toEqual([["__$seqval"]]);
  });
  it("查询、预聚合、脱敏和报表沿用完整列名", () => {
    expect(
      queryDslSchema.parse({
        ...query,
        from: {
          ...query.from,
          pre_aggregate: {
            group_by: ["变更.__$operation"],
            select: [{ field: "变更.__$operation", as: "__$operation" }],
          },
        },
        filters: {
          logic: "and",
          items: [{ field: "变更.__$operation", op: "eq", data_type: "integer", value: 2 }],
        },
        order_by: [{ field: "操作$类型", direction: "asc" }],
      }).type,
    ).toBe("relational_query");
    expect(
      outputMaskSchema.parse({ result_column: "操作$类型", rule: { type: "none" } }).result_column,
    ).toBe("操作$类型");
    expect(
      reportDefinitionSchema.parse({
        title: "变更明细",
        queries: [{ query_id: "main", query }],
        presentation: [
          {
            section_id: "result",
            title: "明细",
            blocks: [
              {
                block_id: "table",
                type: "table",
                title: "变更",
                query_ids: ["main"],
                columns: ["操作$类型"],
              },
            ],
          },
        ],
      }).queries[0].query.type,
    ).toBe("relational_query");
  });
  it("指标日期、去重键和维度支持含美元符号的字段", () => {
    expect(
      metricDefinitionSchema.parse({
        metric_id: "changes",
        version: 1,
        name: "变更次数",
        description: "按变更时间统计",
        aliases: [],
        grain: "一次变更",
        date_basis: { field: "变更.变更$时间", data_type: "datetime" },
        deduplication_keys: ["变更.__$seqval"],
        dimensions: ["变更.__$operation"],
        query: {
          ...query,
          select: [{ field: "变更.__$seqval", aggregation: "count", as: "次数$" }],
        },
        value: { type: "column", column: "次数$" },
        total_rule: "recalculate",
      }).dimensions,
    ).toEqual(["变更.__$operation"]);
  });
  it.each([
    "__$operation;DROP",
    "__$operation--",
    "__$operation/*x*/",
    "__$operation]",
    "__$operation'",
    "__$operation x",
    "$(command)",
  ])("仍拒绝夹带 SQL 或表达式的名称 %s", (name) => {
    expect(
      manageableSourceObjectSchema.safeParse({
        object_id,
        kind: "table",
        native_schema_name: "dbo",
        native_object_name: "temp_t_yp0_drug_list_CT",
        columns: [{ name, data_type: "string", nullable: true }],
      }).success,
    ).toBe(false);
  });
});
