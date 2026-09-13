import { describe, expect, it } from "vitest";

import { queryDslSchema } from "../../src/query/query-dsl";

// 本组检查 DSL 结构与取值规则；对象、字段的实际可用性在目录与规划流程中确认。
describe("查询 DSL 合同", () => {
  it("接受最小关系查询并补齐默认值", () => {
    const result = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "clinical.outpatient_visit", alias: "visit" },
      select: [{ field: "visit.visit_id" }],
    });

    if (result.type !== "relational_query") throw new Error("预期关系查询");

    expect(result.joins).toEqual([]);
    expect(result.filters).toEqual({ logic: "and", items: [] });
    expect(result.group_by).toEqual([]);
    expect(result.order_by).toEqual([]);
  });

  it("接受连接、筛选、聚合、分组、排序和行数上限", () => {
    const result = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "clinical.outpatient_visit", alias: "visit" },
      joins: [
        {
          type: "left",
          object_id: "clinical.department",
          alias: "dept",
          on: [
            { left: "visit.department_id", op: "eq", right: "dept.id" },
            { left: "visit.organization_id", op: "eq", right: "dept.organization_id" },
          ],
        },
      ],
      select: [
        { field: "dept.name", as: "department_name" },
        { field: "visit.visit_id", aggregation: "count", as: "visit_count" },
      ],
      filters: {
        logic: "and",
        items: [
          {
            logic: "or",
            items: [
              { field: "visit.status", op: "eq", data_type: "string", value: "completed" },
              { field: "visit.status", op: "eq", data_type: "string", value: "closed" },
            ],
          },
        ],
      },
      group_by: ["dept.name"],
      order_by: [{ field: "visit_count", direction: "desc" }],
      limit: 100,
    });

    if (result.type !== "relational_query") throw new Error("预期关系查询");

    expect(result.limit).toBe(100);
    expect(result.joins).toHaveLength(1);
  });

  it("拒绝缺少选择项、不安全标识符和非法行数上限", () => {
    expect(() =>
      queryDslSchema.parse({
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit", alias: "visit" },
        select: [],
      }),
    ).toThrow();

    expect(() =>
      queryDslSchema.parse({
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit;DROP TABLE users", alias: "visit" },
        select: [{ field: "visit.id" }],
      }),
    ).toThrow();

    expect(() =>
      queryDslSchema.parse({
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit", alias: "visit" },
        select: [{ field: "visit.id" }],
        limit: 0,
      }),
    ).toThrow();

    expect(() =>
      queryDslSchema.parse({
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit", alias: "visit" },
        select: [{ field: "visit.id" }],
        unexpected: true,
      }),
    ).toThrow();
  });

  it("拒绝没有等值条件的连接", () => {
    expect(() =>
      queryDslSchema.parse({
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit", alias: "visit" },
        select: [{ field: "visit.id" }],
        joins: [
          {
            type: "inner",
            object_id: "clinical.department",
            alias: "dept",
            on: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("接受存储过程或 HTTP API 的参数化查询", () => {
    const result = queryDslSchema.parse({
      type: "parameterized_query",
      source_id: "clinical",
      from: { object_id: "clinical.admission_report", alias: "report" },
      parameters: [
        { name: "admission_date_from", data_type: "date", value: "2026-01-01" },
        { name: "admission_date_to", data_type: "date", value: "2026-01-31" },
      ],
      limit: 100,
    });

    if (result.type !== "parameterized_query") throw new Error("预期参数化查询");

    expect(result.parameters).toHaveLength(2);
    expect(result.parameters[0]?.name).toBe("admission_date_from");
  });

  it("接受 API 已审核的固定输出声明", () => {
    const expected_output = [{ name: "department", data_type: "string", nullable: false }];
    expect(
      queryDslSchema.parse({
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "report", alias: "r" },
        expected_output,
      }),
    ).toMatchObject({ expected_output });
  });

  it.each([
    { expected_output: [] },
    { expected_output: [{ name: "dept", nullable: false }] },
    { expected_output: [{ name: "dept", data_type: "string", nullable: false, hidden: true }] },
    {
      expected_output: [
        { name: "dept", data_type: "string", nullable: false },
        { name: "dept", data_type: "string", nullable: false },
      ],
    },
  ])("拒绝空、无效或重复的固定输出声明 $expected_output", ({ expected_output }) => {
    expect(
      queryDslSchema.safeParse({
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "report", alias: "r" },
        expected_output,
      }).success,
    ).toBe(false);
  });

  it("接受 between 范围条件", () => {
    const result = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "clinical.visit", alias: "visit" },
      select: [{ field: "visit.id" }],
      filters: {
        logic: "and",
        items: [
          {
            field: "visit.admission_date",
            op: "between",
            data_type: "date",
            value: ["2026-01-01", "2026-01-31"],
          },
        ],
      },
    });

    expect(result.type).toBe("relational_query");
  });

  it("拒绝参数化查询附带关系查询专属的排序", () => {
    expect(() =>
      queryDslSchema.parse({
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "clinical.admission_report", alias: "report" },
        parameters: [],
        select: [{ field: "report.patient_name" }],
        order_by: ["report.patient_name"],
      }),
    ).toThrow();
  });

  it("接受升序和降序排序项", () => {
    const result = queryDslSchema.parse({
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "clinical.visit", alias: "visit" },
      select: [{ field: "visit.id" }],
      order_by: [
        { field: "visit.visit_date", direction: "desc" },
        { field: "visit.id", direction: "asc" },
      ],
    });

    if (result.type !== "relational_query") throw new Error("预期关系查询");
    expect(result.order_by[0]?.direction).toBe("desc");
  });

  it("校验日期时间和 Base64 参数类型", () => {
    expect(
      queryDslSchema.safeParse({
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "clinical.export", alias: "export" },
        parameters: [
          { name: "run_at", data_type: "datetime", value: "2026-09-01 12:30:00" },
          { name: "payload", data_type: "buffer", value: "YWJj" },
        ],
      }).success,
    ).toBe(true);
    expect(
      queryDslSchema.safeParse({
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "clinical.export", alias: "export" },
        parameters: [{ name: "run_at", data_type: "datetime", value: "2026-09-01T12:30:00Z" }],
      }).success,
    ).toBe(false);
  });
});
