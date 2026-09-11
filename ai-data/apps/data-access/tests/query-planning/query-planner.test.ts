import { describe, expect, it } from "vitest";

import { QueryPlanner, QueryPlanningError } from "../../src/query-planning/query-planner";
import type { DataSourceConfig, ExposedSourceObject } from "../../src/metadata/metadata-records";

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
  };
}

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

describe("查询规划器", () => {
  // BDD 场景：请求签名无效；TDD 断言：DAS 不读取本地数据源或对象映射。
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

  // BDD 场景：API 已将授权范围合并到 filters 并签名；TDD 断言：DAS 仅映射物理对象并收紧本地限制。
  it("映射物理对象并保留 API 已合并的过滤条件", async () => {
    const planner = createPlanner([exposedObject("clinical.visit")]);
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

  // BDD 场景：API 已完成 Join 业务校验并签名交给 DAS；TDD 断言：DAS 只验证别名结构并映射 Join 的物理对象。
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

  // BDD 场景：DSL 引用未在 DAS 本地白名单启用的对象；TDD 断言：DAS 拒绝物理映射。
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

  // BDD 场景：API 已提供完成的存储过程参数；TDD 断言：DAS 保留参数值并仅标记为通用绑定类型。
  it("映射 API 已完成校验的固定调用参数", async () => {
    const planner = createPlanner([exposedObject("clinical.get_visits", "stored_procedure")]);
    const result = await planner.plan({
      access: access(),
      query: {
        type: "parameterized_query",
        source_id: "clinical",
        from: { object_id: "clinical.get_visits", alias: "g" },
        parameters: [{ name: "department_id", data_type: "string", value: "GYN" }],
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

  // BDD 场景：上游请求包含重名参数；TDD 断言：DAS 在参数绑定前拒绝歧义输入。
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
