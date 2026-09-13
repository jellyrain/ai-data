import { describe, expect, it } from "vitest";

import { executableQuerySchema, type ExecutableQuery } from "../../src/connectors/executable-query";

// 使用已经具备物理映射的样本检查内部 DSL 合同，实际 SQL 生成在编译器测试中验证。
describe("连接器最终可执行查询", () => {
  it("接受带物理对象映射和根级最终过滤条件的关系查询", () => {
    const result = executableQuerySchema.parse({
      type: "relational_query",
      source_id: "clinical_reporting",
      timeout_ms: 15000,
      row_limit: 100,
      from: {
        object_id: "clinical.surgery_record",
        native_schema_name: "clinical",
        native_object_name: "surgery_record",
        alias: "s",
      },
      joins: [
        {
          type: "left",
          relation: {
            object_id: "clinical.surgery_application",
            native_schema_name: "clinical",
            native_object_name: "surgery_application",
            alias: "a",
          },
          on: [{ left: "s.application_id", op: "eq", right: "a.id" }],
        },
      ],
      filters: {
        logic: "and",
        items: [{ field: "s.status", op: "eq", data_type: "string", value: "active" }],
      },
      select: [{ field: "s.id", as: "surgery_id" }],
      group_by: [],
      order_by: [{ field: "s.id", direction: "asc" }],
    });

    expect(result.from.native_object_name).toBe("surgery_record");
    expect(result.row_limit).toBe(100);
  });

  it("拒绝携带 API 权限请求字段的最终查询", () => {
    expect(
      executableQuerySchema.safeParse({
        type: "parameterized_query",
        source_id: "his_api",
        timeout_ms: 15000,
        row_limit: 100,
        from: {
          object_id: "patient_visits",
          native_object_name: "patient_visits",
          alias: "v",
        },
        parameters: [],
        access: { user_id: "should-not-reach-connector" },
      }).success,
    ).toBe(false);
  });

  it("拒绝缺少物理对象名称的最终查询", () => {
    expect(
      executableQuerySchema.safeParse({
        type: "parameterized_query",
        source_id: "his_api",
        timeout_ms: 15000,
        row_limit: 100,
        from: {
          object_id: "patient_visits",
          alias: "v",
        },
        parameters: [],
      }).success,
    ).toBe(false);
  });

  it("接受参数化数据集的最终参数值", () => {
    const query: ExecutableQuery = executableQuerySchema.parse({
      type: "parameterized_query",
      source_id: "his_api",
      timeout_ms: 12000,
      row_limit: 50,
      from: {
        object_id: "patient_visits",
        native_object_name: "patient_visits",
        alias: "v",
      },
      parameters: [{ name: "start_date", data_type: "date", value: "2026-08-01" }],
    });

    expect(query.type).toBe("parameterized_query");
    if (query.type === "parameterized_query") {
      expect(query.parameters[0]).toMatchObject({ name: "start_date", value: "2026-08-01" });
    }
  });
});
