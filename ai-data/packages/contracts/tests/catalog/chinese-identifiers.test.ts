import { describe, expect, it } from "vitest";
import {
  manageableSourceObjectSchema,
  sourceObjectSelectionRequestSchema,
  datasetSchema,
  apiDatasetConfigSchema,
  queryDslSchema,
  outputMaskSchema,
  reportDefinitionSchema,
  metricDefinitionSchema,
} from "../../src/index";

const columns = [
  { name: "科室编号", data_type: "integer", nullable: false },
  { name: "科室名称", data_type: "string", nullable: false },
  { name: "就诊时间", data_type: "datetime", nullable: false },
];
const query = {
  type: "relational_query",
  source_id: "业务库",
  from: { object_id: "table.dbo.科室", alias: "科室" },
  select: [{ field: "科室.科室名称", as: "名称" }],
};

describe("中文表、视图和字段的合同贯通", () => {
  it.each(["table", "view"])("%s 发现、选择及公共目录保留中文名称", (kind) => {
    const object_id = `${kind}.dbo.科室`;
    expect(
      manageableSourceObjectSchema.parse({
        object_id,
        kind,
        native_schema_name: "dbo",
        native_object_name: "科室",
        columns,
      }).columns,
    ).toEqual(columns);
    expect(
      sourceObjectSelectionRequestSchema.parse({
        source_id: "业务库",
        objects: [{ object_id, discovered_object_id: object_id }],
      }).objects[0].object_id,
    ).toBe(object_id);
    expect(
      datasetSchema.parse({ source_id: "业务库", object_id, name: "科室", kind, columns }).columns,
    ).toEqual(columns);
  });
  it("中文字段可用于关系、查询、预聚合、脱敏及报表", () => {
    const config = apiDatasetConfigSchema.parse({
      source_id: "业务库",
      object_id: "table.dbo.科室",
      unique_keys: [["科室编号"]],
      approved_relations: [
        {
          target_object_id: "view.dbo.门诊明细",
          description: "所属科室",
          column_pairs: [{ source_column: "科室编号", target_column: "科室编号" }],
        },
      ],
      column_policies: [
        {
          field: "科室名称",
          default_masking: { type: "partial_mask", prefix_length: 1, suffix_length: 0 },
        },
      ],
    });
    expect(config.unique_keys).toEqual([["科室编号"]]);
    expect(
      queryDslSchema.parse({
        ...query,
        from: {
          ...query.from,
          pre_aggregate: {
            group_by: ["科室.科室名称"],
            select: [{ field: "科室.科室名称", as: "科室名称" }],
          },
        },
        filters: {
          logic: "and",
          items: [{ field: "科室.科室名称", op: "eq", data_type: "string", value: "内科" }],
        },
        order_by: [{ field: "名称", direction: "asc" }],
      }).type,
    ).toBe("relational_query");
    expect(
      outputMaskSchema.parse({ result_column: "名称", rule: { type: "none" } }).result_column,
    ).toBe("名称");
    expect(
      reportDefinitionSchema.parse({
        title: "科室明细",
        queries: [{ query_id: "main", query }],
        presentation: [
          {
            section_id: "result",
            title: "明细",
            blocks: [
              {
                block_id: "table",
                type: "table",
                title: "科室",
                query_ids: ["main"],
                columns: ["名称"],
              },
            ],
          },
        ],
      }).queries[0].query.type,
    ).toBe("relational_query");
  });
  it("指标的日期依据、去重键和维度可引用中文字段", () => {
    expect(
      metricDefinitionSchema.parse({
        metric_id: "visits",
        version: 1,
        name: "就诊次数",
        description: "按就诊时间统计",
        aliases: [],
        grain: "一次就诊",
        date_basis: { field: "科室.就诊时间", data_type: "datetime" },
        deduplication_keys: ["科室.科室编号"],
        dimensions: ["科室.科室名称"],
        query: { ...query, select: [{ field: "科室.科室编号", aggregation: "count", as: "次数" }] },
        value: { type: "column", column: "次数" },
        total_rule: "recalculate",
      }).date_basis.field,
    ).toBe("科室.就诊时间");
  });
  it.each(["科室;DROP", "科室--注释", "科室/*注释*/", "科室]", "科室'", "科室 名称", "科室/名称"])(
    "中文名称仍拒绝 SQL 元字符或空格：%s",
    (name) => {
      expect(
        datasetSchema.safeParse({
          source_id: "业务库",
          object_id: "table.dbo.科室",
          name: "科室",
          kind: "table",
          columns: [{ name, data_type: "string", nullable: true }],
        }).success,
      ).toBe(false);
      expect(
        queryDslSchema.safeParse({ ...query, from: { ...query.from, object_id: name } }).success,
      ).toBe(false);
    },
  );
});
