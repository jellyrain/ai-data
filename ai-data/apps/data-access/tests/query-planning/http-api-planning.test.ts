import { describe, expect, it, vi } from "vitest";

import { QueryPlanner } from "../../src/query-planning/query-planner";
import type { ApiDatasetMapping } from "../../src/connectors/api-dataset-mapping-types";

const mapping: ApiDatasetMapping = {
  sourceId: "api",
  objectId: "report",
  request: {
    method: "GET",
    path: "/report",
    parameterMappings: [
      {
        name: "department",
        location: "query",
        key: "dept",
        dataType: "integer",
        required: true,
        defaultValue: 7,
      },
    ],
  },
  response: {
    mode: "list",
    path: "$.data[*]",
    fields: [{ name: "id", jsonPath: "$.id", dataType: "integer", nullable: false }],
  },
};

// HTTP 映射仓储就是当前数据源的受控对象目录，执行规划直接读取它核对签名输出。
describe("HTTP API 固定调用规划", () => {
  it("按虚拟表定义核对输出、补默认参数并映射物理对象", async () => {
    const lookup = vi.fn();
    const result = await createPlanner(mapping, lookup).plan(request());
    expect(lookup).not.toHaveBeenCalled();
    expect(result.query).toMatchObject({
      from: { object_id: "report", native_object_name: "report" },
      parameters: [{ name: "department", data_type: "integer", value: 7 }],
      fixed_output: [{ name: "id", data_type: "integer", nullable: false }],
    });
  });
  it("本地输出新增列后拒绝旧授权请求", async () => {
    await expect(
      createPlanner({
        ...mapping,
        response: {
          ...mapping.response,
          fields: [
            ...mapping.response.fields,
            { name: "phone", jsonPath: "$.phone", dataType: "string", nullable: false },
          ],
        },
      }).plan(request()),
    ).rejects.toThrow(/固定输出/);
  });
  it("未配置的虚拟表不能执行", async () => {
    await expect(createPlanner(undefined).plan(request())).rejects.toThrow(/未配置/);
  });
});

/** 构造已启用 HTTP 数据源与映射仓储替身。 */
function createPlanner(value: ApiDatasetMapping | undefined, findQueryable = vi.fn()) {
  return new QueryPlanner(
    {
      findEnabledBySourceId: async () => ({
        sourceId: "api",
        connectorKind: "http_api",
        secretRef: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 10,
        costLimit: 1,
      }),
    },
    { findQueryableBySourceIdAndObjectId: findQueryable },
    { verify: async () => {} },
    { findBySourceIdAndObjectId: async () => value },
  );
}

/** API 按单列完整输出完成授权后的签名载荷。 */
function request() {
  return {
    signature: "test",
    access: {
      user_id: "u",
      organization_id: "o",
      analysis_run_id: "r",
      policy_version: 1,
      expires_at: "2026-09-13 10:00:00",
      output_masks: [],
    },
    query: {
      type: "parameterized_query",
      source_id: "api",
      from: { object_id: "report", alias: "r" },
      parameters: [],
      expected_output: [{ name: "id", data_type: "integer", nullable: false }],
    },
  };
}
