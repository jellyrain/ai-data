import { describe, expect, it } from "vitest";

import { QueryPlanner, QueryPlanningError } from "../../src/query-planning/query-planner";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";
import type { ExposedSourceObject } from "../../src/catalog/catalog-types";

const sourceConfig: DataSourceConfig = {
  sourceId: "clinical",
  connectorKind: "sqlserver",
  secretRef: "clinical-server",
  targetDatabase: "clinical_reporting",
  timeoutMs: 12000,
  connectionPoolLimit: 10,
  concurrencyLimit: 20,
  rowLimit: 100,
  costLimit: 1000,
};

/** 将测试逻辑对象映射到固定 dbo Schema，便于核对规划后的物理名称。 */
function exposedObject(
  objectId: string,
  objectKind: ExposedSourceObject["objectKind"] = "table",
): ExposedSourceObject {
  return {
    sourceId: "clinical",
    objectId,
    objectKind,
    nativeSchemaName: "dbo",
    nativeObjectName: objectId.replace("clinical.", ""),
    isDiscoverable: true,
    isQueryable: true,
    queryCapabilities: {},
    ...(objectKind === "stored_procedure"
      ? {
          procedureDefinition: {
            query_parameters: [
              {
                name: "department_id",
                data_type: "string" as const,
                required: true,
                allowed_ops: ["eq" as const],
              },
            ],
            columns: [{ name: "id", data_type: "integer" as const, nullable: false }],
          },
        }
      : {}),
  };
}

/** 构造内存目录与可注入校验器，默认模拟已通过请求校验。 */
function createPlanner(
  objects: ExposedSourceObject[],
  verify: () => Promise<void> = async () => undefined,
) {
  return new QueryPlanner(
    { findEnabledBySourceId: async () => sourceConfig },
    {
      findQueryableBySourceIdAndObjectId: async (_sourceId, objectId) =>
        objects.find((object) => object.objectId === objectId),
    },
    { verify: async () => verify() },
  );
}

/** 提供结构合法的审计上下文，日期仅用于载荷解析。 */
function access() {
  return {
    user_id: "user-001",
    organization_id: "org-001",
    analysis_run_id: "run-001",
    policy_version: 1,
    expires_at: "2026-08-31 12:00:00",
    output_masks: [],
  };
}

// 通过注入的校验器控制验签结果，重点检查规划映射及本地资源上限。
describe("查询规划器", () => {
  // 注入校验器异常，检查规划调用将该失败返回给调用方。
  it("在映射前拒绝验签失败的请求", async () => {
    const planner = createPlanner([exposedObject("clinical.visit")], async () => {
      throw new Error("签名无效");
    });

    await expect(
      planner.plan({
        access: access(),
        query: {
          type: "relational_query",
          source_id: "clinical",
          from: { object_id: "clinical.visit", alias: "v" },
          select: [{ field: "v.id" }],
        },
        signature: "invalid-signature",
      }),
    ).rejects.toThrow("签名无效");
  });

  it("映射物理对象并保留 API 已合并的过滤条件", async () => {
    const planner = createPlanner([exposedObject("clinical.visit")]);
    // 请求 200 行，数据源只允许 100 行；规划后应保留过滤值并采用较小上限。
    const result = await planner.plan({
      access: access(),
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit", alias: "v" },
        select: [{ field: "v.id" }],
        filters: {
          logic: "and",
          items: [
            { field: "v.department_id", op: "eq", data_type: "string", value: "GYN" },
            { field: "v.patient_id", op: "eq", data_type: "string", value: "P001" },
          ],
        },
        limit: 200,
      },
      signature: "signed-request",
    });

    expect(result.query).toMatchObject({
      type: "relational_query",
      timeout_ms: 12000,
      row_limit: 100,
    });
    if (result.query.type === "relational_query") {
      expect(result.query.from).toMatchObject({
        native_schema_name: "dbo",
        native_object_name: "visit",
      });
      expect(result.query.filters.items).toEqual([
        { field: "v.department_id", op: "eq", data_type: "string", value: "GYN" },
        { field: "v.patient_id", op: "eq", data_type: "string", value: "P001" },
      ]);
    }
  });

  it("保留 API 已签名的 Join 条件", async () => {
    const planner = createPlanner([
      exposedObject("clinical.visit"),
      exposedObject("clinical.patient"),
    ]);
    const result = await planner.plan({
      access: access(),
      query: {
        type: "relational_query",
        source_id: "clinical",
        from: { object_id: "clinical.visit", alias: "v" },
        joins: [
          {
            type: "inner",
            object_id: "clinical.patient",
            alias: "p",
            on: [{ left: "v.patient_id", op: "eq", right: "p.patient_id" }],
          },
        ],
        select: [{ field: "v.id" }],
      },
      signature: "signed-request",
    });

    expect(result.query).toMatchObject({ type: "relational_query" });
    if (result.query.type === "relational_query") {
      expect(result.query.joins[0]).toMatchObject({
        relation: { native_object_name: "patient", alias: "p" },
        on: [{ left: "v.patient_id", op: "eq", right: "p.patient_id" }],
      });
    }
  });

  it("拒绝未配置为可查询的对象", async () => {
    const planner = createPlanner([exposedObject("clinical.patient")]);
    await expect(
      planner.plan({
        access: access(),
        query: {
          type: "relational_query",
          source_id: "clinical",
          from: { object_id: "clinical.visit", alias: "v" },
          select: [{ field: "v.id" }],
        },
        signature: "signed-request",
      }),
    ).rejects.toThrow("对象未配置为可查询: clinical.visit");
  });

  it("映射 API 已完成校验的固定调用参数", async () => {
    const planner = createPlanner([exposedObject("clinical.get_visits", "stored_procedure")]);
    const result = await planner.plan({
      access: access(),
      query: {
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "clinical.get_visits", alias: "g" },
        parameters: [{ name: "department_id", data_type: "string", value: "GYN" }],
        expected_output: [{ name: "id", data_type: "integer", nullable: false }],
      },
      signature: "signed-request",
    });

    expect(result.query).toMatchObject({ type: "parameterized_query" });
    if (result.query.type === "parameterized_query") {
      expect(result.query.parameters).toEqual([
        { name: "department_id", data_type: "string", value: "GYN" },
      ]);
    }
  });

  it("拒绝重复参数名", async () => {
    const planner = createPlanner([exposedObject("clinical.get_visits", "stored_procedure")]);
    await expect(
      planner.plan({
        access: access(),
        query: {
          type: "parameterized_query",
          source_id: "clinical",
          from: { object_id: "clinical.get_visits", alias: "g" },
          parameters: [
            { name: "department_id", data_type: "string", value: "GYN" },
            { name: "department_id", data_type: "string", value: "OB" },
          ],
        },
        signature: "signed-request",
      }),
    ).rejects.toThrow(QueryPlanningError);
  });
});
