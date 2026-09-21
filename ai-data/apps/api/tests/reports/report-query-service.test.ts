import { describe, expect, it, vi } from "vitest";
import { reportDefinitionSchema, queryDslSchema } from "@ai-data/contracts";
import { ReportQueryService } from "../../src/reports/report-query-service";
import { context } from "../support/api-fixtures";

const base = {
  title: "科室查询",
  parameters: [{ name: "department", label: "科室", data_type: "string", required: true }],
  queries: [
    {
      query_id: "q",
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "visits", alias: "v" },
        select: [{ field: "v.department", as: "department" }],
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
      section_id: "s",
      title: "明细",
      blocks: [{ block_id: "b", title: "明细", type: "table", query_ids: ["q"] }],
    },
  ],
};
function setup() {
  const authorize = vi.fn(async (query: unknown) => ({
    request: { query: queryDslSchema.parse(query), access: { output_masks: [] } },
    token: "token",
  }));
  const getAuthorized = vi.fn(async () => ({
    dataset: {
      columns: [
        { name: "department", data_type: "string" },
        { name: "id", data_type: "integer" },
      ],
    },
  }));
  const getAuthorizedConfig = vi.fn(async () => ({
    approved_relations: [
      {
        relation_id: "dept",
        target_object_id: "departments",
        column_pairs: [{ source_column: "department", target_column: "department" }],
        allowed_join_types: ["left"],
      },
    ],
  }));
  const service = new ReportQueryService({
    authorization: { authorize },
    catalog: { getAuthorized, getAuthorizedConfig },
    metrics: { get: vi.fn() },
  } as unknown as ConstructorParameters<typeof ReportQueryService>[0]);
  return { service, authorize, getAuthorizedConfig };
}
describe("公共报表查询构建", () => {
  it("保存只声明负数上限的参数时使用合法示例值", async () => {
    const h = setup();
    const definition = reportDefinitionSchema.parse({
      ...base,
      parameters: [{ name: "department", label: "上限", data_type: "integer", max: -1 }],
    });
    definition.queries[0].bindings[0].target = {
      type: "filter",
      field: "v.id",
      op: "eq",
      scope: "query",
    };
    await expect(h.service.validate(context, definition)).resolves.toBeUndefined();
  });
  it("二次编辑追加参数后绑定到新定义且只生成一份查询", async () => {
    const h = setup();
    const definition = reportDefinitionSchema.parse(base);
    await h.service.validate(context, definition);
    const output = await h.service.build(context, definition, { department: "A" });
    expect(output.queries).toHaveLength(1);
    expect(output.queries[0].query).toMatchObject({
      filters: {
        items: expect.arrayContaining([
          { field: "v.department", op: "eq", data_type: "string", value: "A" },
        ]),
      },
    });
    expect(h.authorize).toHaveBeenCalled();
  });
  it("缺少必填、未知参数和越界值在查询前拒绝", async () => {
    const h = setup();
    const definition = reportDefinitionSchema.parse(base);
    await expect(h.service.build(context, definition, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(h.service.build(context, definition, { department: 9 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      h.service.build(context, definition, { department: "A", secret: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it("批准关系生成完整字段对，错误方向与未批准连接方式被拒绝", async () => {
    const h = setup();
    const definition = reportDefinitionSchema.parse({
      ...base,
      queries: [
        {
          ...base.queries[0],
          query: {
            ...base.queries[0].query,
            joins: [
              {
                source_alias: "v",
                alias: "d",
                object_id: "departments",
                relation_id: "dept",
                type: "left",
              },
            ],
          },
        },
      ],
    });
    const result = await h.service.build(context, definition, { department: "A" });
    expect(result.queries[0].query).toMatchObject({
      joins: [{ on: [{ left: "v.department", op: "eq", right: "d.department" }] }],
    });
    definition.queries[0].query = {
      ...definition.queries[0].query,
      joins: [
        {
          source_alias: "missing",
          alias: "d",
          object_id: "departments",
          relation_id: "dept",
          type: "left",
        },
      ],
    } as (typeof definition.queries)[0]["query"];
    await expect(h.service.build(context, definition, { department: "A" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
  it("可选参数未提供时省略条件，相对时间在运行时按当前日历解析", async () => {
    const h = setup();
    const definition = reportDefinitionSchema.parse({
      ...base,
      parameters: [
        { ...base.parameters[0], required: false },
        {
          name: "start",
          label: "开始",
          data_type: "date",
          relative_time: { range: { type: "relative", period: "this_month" }, part: "start" },
        },
      ],
    });
    const result = await h.service.build(context, definition, {});
    expect(result.parameters.start).toMatch(/^\d{4}-\d{2}-01$/);
    expect(result.queries[0].query).toMatchObject({ filters: { items: [] } });
  });
});
