import { describe, expect, it } from "vitest";
import { reportDefinitionSchema, reportExecutionInputSchema } from "../../src/index";

/** 同一结构供表单、对话和画布保存；引用校验在进入服务前完成。 */
const definition = {
  title: "就诊统计",
  parameters: [{ name: "department", label: "科室", data_type: "string", required: false }],
  queries: [
    {
      query_id: "visits",
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visits", alias: "v" },
        select: [{ field: "v.id" }],
      },
      bindings: [
        {
          parameter: "department",
          target: { type: "filter", field: "v.department", op: "eq", scope: "query" },
        },
      ],
    },
  ],
  presentation: [
    {
      section_id: "main",
      title: "统计",
      blocks: [{ block_id: "table", type: "table", title: "明细", query_ids: ["visits"] }],
    },
  ],
};

describe("统一报表定义", () => {
  it("保存参数与查询引用，多个展示块可以共用一个查询", () => {
    const parsed = reportDefinitionSchema.parse(definition);
    expect(parsed.queries).toHaveLength(1);
    expect(parsed.parameters[0].required).toBe(false);
  });
  it("删除仍被绑定的参数和引用不存在的查询均拒绝", () => {
    expect(reportDefinitionSchema.safeParse({ ...definition, parameters: [] }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, queries: [] }).success).toBe(false);
  });
  it("重复查询标识、未知字段和不符类型的默认值均拒绝", () => {
    expect(
      reportDefinitionSchema.safeParse({
        ...definition,
        queries: [...definition.queries, ...definition.queries],
      }).success,
    ).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, raw_sql: "select 1" }).success).toBe(
      false,
    );
    expect(
      reportDefinitionSchema.safeParse({
        ...definition,
        parameters: [{ ...definition.parameters[0], default_value: 1 }],
      }).success,
    ).toBe(false);
  });
  it("执行固定版本并使用操作键，拒绝缺失版本", () => {
    expect(
      reportExecutionInputSchema.safeParse({
        definition_version: 2,
        idempotency_key: "run-2",
        parameters: { department: "A" },
      }).success,
    ).toBe(true);
    expect(reportExecutionInputSchema.safeParse({ idempotency_key: "run-2" }).success).toBe(false);
  });
});
