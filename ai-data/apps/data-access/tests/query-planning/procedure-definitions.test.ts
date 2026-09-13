import { describe, expect, it } from "vitest";

import { sourceObjectSelectionRequestSchema } from "../../src/data-sources/data-source-management-service";
import { QueryPlanner } from "../../src/query-planning/query-planner";
import { CatalogService } from "../../src/catalog/catalog-service";
import type { ExposedSourceObject } from "../../src/catalog/catalog-types";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";
import { postgresqlDialect } from "../../src/connectors/dialects/postgresql-dialect";

const definition = {
  query_parameters: [
    { name: "department", allowed_ops: ["eq"], data_type: "string", required: true },
    { name: "count", allowed_ops: ["eq"], data_type: "integer", required: true, default_value: 5 },
  ],
  columns: [{ name: "id", data_type: "integer", nullable: false }],
};
const object = {
  sourceId: "clinical",
  objectId: "visits",
  objectKind: "stored_procedure",
  nativeSchemaName: "dbo",
  nativeObjectName: "get_visits",
  isQueryable: true,
  isDiscoverable: true,
  queryCapabilities: {},
  procedureDefinition: definition,
} as ExposedSourceObject;

// 管理员保存完整签名后，目录与执行规划必须读取同一份持久化定义。
describe("管理员过程定义与执行规划", () => {
  it("对象管理请求接受完整的输入输出定义", () => {
    expect(
      sourceObjectSelectionRequestSchema.safeParse({
        source_id: "clinical",
        objects: [
          { object_id: "stored_procedure.dbo.get_visits", procedure_definition: definition },
        ],
      }).success,
    ).toBe(true);
  });
  it("空输出定义不能成为可执行过程", () => {
    expect(
      sourceObjectSelectionRequestSchema.safeParse({
        source_id: "clinical",
        objects: [
          {
            object_id: "stored_procedure.dbo.get_visits",
            procedure_definition: { ...definition, columns: [] },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("规划按管理员顺序绑定输入并补默认值", async () => {
    const result = await plan([{ name: "department", data_type: "string", value: "A" }]);
    expect(result.query).toMatchObject({
      parameters: [
        { name: "department", data_type: "string", value: "A" },
        { name: "count", data_type: "integer", value: 5 },
      ],
      fixed_output: definition.columns,
    });
  });
  it.each([
    [],
    [{ name: "department", data_type: "integer", value: 1 }],
    [
      { name: "department", data_type: "string", value: "A" },
      { name: "unexpected", data_type: "string", value: "B" },
    ],
  ])("拒绝缺失、类型不符或未知输入 %#", async (...parameters) => {
    await expect(plan(parameters)).rejects.toThrow(/参数/);
  });
  it("未配置完整定义时拒绝过程调用", async () => {
    const unconfigured = { ...object };
    delete unconfigured.procedureDefinition;
    await expect(plan([], unconfigured)).rejects.toThrow(/定义/);
  });
  it("目录保留对象类型并合并管理员固定输入输出", async () => {
    const service = new CatalogService(
      {
        get: async () => ({
          sourceId: "clinical",
          kind: "sqlserver",
          discoverCatalog: async () => [
            {
              kind: "stored_procedure",
              native_schema_name: "dbo",
              native_object_name: "get_visits",
              columns: [],
            },
          ],
          execute: async () => {
            throw new Error("不执行");
          },
          close: async () => {},
          checkHealth: async () => ({
            source_id: "clinical",
            status: "healthy",
            checked_at: "2026-09-13 10:00:00",
          }),
        }),
      },
      { listDiscoverableBySourceId: async () => [object] },
    );
    expect(await service.listBySourceId("clinical")).toMatchObject([
      {
        kind: "stored_procedure",
        has_complete_output: true,
        query_parameters: definition.query_parameters,
        columns: definition.columns,
      },
    ]);
  });
  it("PostgreSQL 过程编译使用 CALL 且补齐 OUT 参数位置", async () => {
    const result = await plan(
      [{ name: "department", data_type: "string", value: "A" }],
      {
        ...object,
        procedureDefinition: {
          ...definition,
          postgresql_parameter_types: ["text", "integer"],
          output_parameters: [{ name: "id", data_type: "integer", position: 1 }],
        },
      } as ExposedSourceObject,
      "postgresql",
    );
    const compiled = compileSqlQuery(result.query, postgresqlDialect);
    expect(compiled.sql).toBe('CALL "dbo"."get_visits"($1::text, NULL, $2::integer)');
  });
  it("PostgreSQL 输入缺少原生签名类型时拒绝调用", async () => {
    await expect(
      plan([{ name: "department", data_type: "string", value: "A" }], object, "postgresql"),
    ).rejects.toThrow(/原生参数类型/);
  });
});

/** 模拟本地白名单读取，规划请求包含合法审计上下文。 */
function plan(
  parameters: unknown[],
  exposed = object,
  kind: "sqlserver" | "postgresql" = "sqlserver",
) {
  return new QueryPlanner(
    {
      findEnabledBySourceId: async () => ({
        sourceId: "clinical",
        connectorKind: kind,
        secretRef: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 10,
        costLimit: 10,
      }),
    },
    { findQueryableBySourceIdAndObjectId: async () => exposed },
    { verify: async () => {} },
  ).plan({
    access: {
      user_id: "u",
      organization_id: "o",
      analysis_run_id: "run",
      policy_version: 1,
      expires_at: "2026-09-13 10:00:00",
      output_masks: [],
    },
    signature: "test",
    query: {
      type: "parameterized_query",
      source_id: "clinical",
      from: { object_id: "visits", alias: "v" },
      parameters,
      expected_output: definition.columns,
    },
  });
}
