import { describe, expect, it } from "vitest";
import { catalogRelationSchema } from "@ai-data/contracts";
import { definition } from "./fixtures";
import {
  connectRelation,
  removeObject,
  queryFields,
  replacePrimary,
} from "../../../src/features/reports/models/query-editing";

const relation = catalogRelationSchema.parse({
  source_id: "demo",
  object_id: "visits",
  target_object_id: "department",
  relation_id: "department",
  description: "就诊科室",
  column_pairs: [{ source_column: "department", target_column: "id" }],
  allowed_join_types: ["left"],
  version: 1,
  enabled: true,
  updated_at: "2026-09-28 08:00:00",
});
describe("批准关系与查询属性", () => {
  it("更换源对象保留查询标识与展示位置，清理旧关系和字段绑定", () => {
    const value = structuredClone(definition.definition);
    value.queries[0]!.bindings = [
      { parameter: "min", target: { type: "filter", field: "v.count", op: "eq", scope: "query" } },
    ];
    const result = replacePrimary(value, "visits", {
      source_id: "new-source",
      object_id: "new_object",
      kind: "table",
      name: "新对象",
      query_parameters: [],
      columns: [{ name: "amount", data_type: "decimal", nullable: false }],
    });
    expect(result.queries[0]).toMatchObject({
      query_id: "visits",
      bindings: [],
      query: {
        source_id: "new-source",
        from: { object_id: "new_object", alias: "v" },
        joins: [],
        select: [{ field: "v.amount", as: "amount" }],
      },
    });
    expect(result.presentation[0]!.blocks[0]!.block_id).toBe("table");
    expect(value.queries[0]!.bindings).toHaveLength(1);
  });
  it("新增关联保持批准方向和连接类型，非法方向及循环替换拒绝", () => {
    const initial = definition.definition.queries[0]!.query;
    if (initial.type !== "relational_query") throw new Error("测试需要关系查询");
    const query = connectRelation(initial, "v", relation, "left");
    expect(query.joins[0]).toMatchObject({
      source_alias: "v",
      object_id: "department",
      relation_id: "department",
      type: "left",
    });
    expect(() => connectRelation(initial, "v", relation, "inner")).toThrow();
    expect(() => connectRelation(initial, "missing", relation, "left")).toThrow();
    expect(() =>
      connectRelation(
        query,
        query.joins[0]!.alias,
        { ...relation, object_id: "department", target_object_id: "visits" },
        "left",
        "v",
      ),
    ).toThrow();
  });
  it("移除对象同时移除依赖它的后续关联和字段，其他条件保留", () => {
    const draft = structuredClone(definition.definition),
      query = draft.queries[0]!.query;
    if (query.type !== "relational_query") throw new Error("测试需要关系查询");
    query.joins = [
      {
        alias: "d",
        source_alias: "v",
        relation_id: "department",
        object_id: "department",
        type: "left",
      },
      {
        alias: "d2",
        source_alias: "d",
        relation_id: "parent",
        object_id: "department",
        type: "left",
      },
    ];
    query.select.push({ field: "d.name", as: "department_name" });
    query.filters = {
      logic: "and",
      items: [
        { field: "d2.name", op: "eq", data_type: "string", value: "a" },
        { field: "v.count", op: "eq", data_type: "integer", value: 1 },
      ],
    };
    const result = removeObject(draft, "visits", "d").queries[0]!.query;
    expect(result).toMatchObject({
      joins: [],
      select: [{ field: "v.department" }, { field: "v.count" }],
      filters: { items: [{ field: "v.count" }] },
    });
  });
  it("预聚合外层只选择声明的输出，原始对象条件仍使用原始字段", () => {
    const query = structuredClone(definition.definition.queries[0]!.query);
    if (query.type !== "relational_query") throw new Error("测试需要关系查询");
    query.from.pre_aggregate = {
      group_by: ["v.department"],
      select: [
        { field: "v.department", as: "department" },
        { field: "v.count", aggregation: "sum", as: "total" },
      ],
    };
    const datasets = [
      {
        source_id: "demo",
        object_id: "visits",
        name: "就诊",
        kind: "table" as const,
        query_parameters: [],
        columns: [
          { name: "department", data_type: "string" as const, nullable: false },
          { name: "count", data_type: "integer" as const, nullable: false },
        ],
      },
    ];
    expect(queryFields(query, datasets).map((f) => f.name)).toEqual(["v.department", "v.total"]);
    expect(queryFields(query, datasets, "v", true).map((f) => f.name)).toEqual([
      "v.department",
      "v.count",
    ]);
  });
});
