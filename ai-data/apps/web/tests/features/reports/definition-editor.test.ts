import { describe, expect, it } from "vitest";
import { reportDefinitionSchema } from "@ai-data/contracts";
import { definition } from "./fixtures";
import {
  appendQuery,
  renameParameter,
  renameQuery,
  renameAlias,
  removeParameter,
  removeQuery,
  definitionIssues,
} from "../../../src/features/reports/models/definition-editor";
import { graphForQuery, nodeId, moveNode } from "../../../src/features/reports/models/query-graph";

describe("表单与画布的统一报表草稿", () => {
  it("增加编排查询保留当前独立报表展示", () => {
    const original = structuredClone(definition.definition);
    const next = appendQuery(original, { ...original.queries[0]!, query_id: "second" }, "附加数据");
    expect(next.queries).toHaveLength(original.queries.length + 1);
    expect(next.presentation).toEqual(original.presentation);
  });
  function draft() {
    const value = structuredClone(definition.definition);
    value.queries[0]!.bindings = [
      { parameter: "min", target: { type: "filter", field: "v.count", op: "eq", scope: "query" } },
    ];
    value.block_references = [
      {
        block_id: "block",
        version: 2,
        query_id_map: { origin: "visits" },
        parameter_map: { floor: "min" },
      },
    ];
    return value;
  }
  it("参数和查询改名同步绑定、展示、固定块映射，原基准保持不变", () => {
    const original = draft();
    const value = renameQuery(
      renameParameter(original, "min", "minimum"),
      "visits",
      "visits_total",
    );
    expect(original.parameters[0]!.name).toBe("min");
    expect(value.queries[0]!.bindings[0]!.parameter).toBe("minimum");
    expect(value.presentation[0]!.blocks[0]!.query_ids).toEqual(["visits_total"]);
    expect(value.block_references[0]).toMatchObject({
      query_id_map: { origin: "visits_total" },
      parameter_map: { floor: "minimum" },
    });
    expect(reportDefinitionSchema.safeParse(value).success).toBe(true);
  });
  it("别名改名只修改字段引用与关系来源，不修改筛选文字和其他查询", () => {
    const value = draft(),
      q = value.queries[0]!.query;
    if (q.type !== "relational_query") throw new Error("测试需要关系查询");
    q.filters = {
      logic: "or",
      items: [{ field: "v.department", op: "eq", data_type: "string", value: "v.department" }],
    };
    q.joins = [
      {
        type: "left",
        object_id: "visits",
        alias: "previous",
        source_alias: "v",
        relation_id: "previous_visit",
      },
    ];
    const renamed = renameAlias(value, "visits", "v", "current");
    const query = renamed.queries[0]!.query;
    expect(query).toMatchObject({
      from: { alias: "current" },
      joins: [{ source_alias: "current" }],
      filters: { items: [{ field: "current.department", value: "v.department" }] },
    });
    expect(renamed.queries[0]!.bindings[0]!.target).toMatchObject({ field: "current.count" });
  });
  it("删除参数与查询显式移除其依赖，固定块解除引用后保留其余展开内容", () => {
    const value = removeParameter(draft(), "min");
    expect(value.parameters).toEqual([]);
    expect(value.queries[0]!.bindings).toEqual([]);
    expect(value.block_references).toEqual([]);
    const empty = removeQuery(value, "visits");
    expect(empty.queries).toEqual([]);
    expect(empty.presentation).toEqual([]);
    expect(definitionIssues(empty).length).toBeGreaterThan(0);
  });
  it("对象别名改名同步依赖隐式输出名称的展示字段", () => {
    const value = draft();
    value.presentation[0]!.blocks[0]!.columns = ["v_department"];
    value.presentation[0]!.blocks[1]!.chart = { type: "bar", x: "v_department", y: "v_count" };
    const renamed = renameAlias(value, "visits", "v", "current");
    expect(renamed.presentation[0]!.blocks[0]!.columns).toEqual(["current_department"]);
    expect(renamed.presentation[0]!.blocks[1]!.chart).toMatchObject({
      x: "current_department",
      y: "current_count",
    });
  });
  it("同表多别名生成独立节点和方向边，移动仅改变布局并可恢复", () => {
    const value = draft(),
      q = value.queries[0]!.query;
    if (q.type !== "relational_query") throw new Error("测试需要关系查询");
    q.joins = [
      {
        type: "left",
        object_id: "visits",
        alias: "previous",
        source_alias: "v",
        relation_id: "previous_visit",
      },
    ];
    const id = nodeId("visits", "previous");
    const moved = moveNode(value, id, { x: 712, y: 204 });
    const graph = graphForQuery(moved, "visits");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes.find((n) => n.id === id)?.position).toEqual({ x: 712, y: 204 });
    expect(graph.edges[0]).toMatchObject({ source: nodeId("visits", "v"), target: id });
    expect(moved.queries).toEqual(value.queries);
    expect(moved.presentation).toEqual(value.presentation);
  });
});
