import { describe, expect, it } from "vitest";

import { QueryPlanner } from "../../src/query-planning/query-planner";

// 签名中的列定义来自 API 审核瞬间，DAS 本地配置更新后旧请求必须重新授权。
describe("固定输出授权与本地定义同步", () => {
  it.each([
    undefined,
    [],
    [{ name: "id", data_type: "string", nullable: false }],
    [{ name: "other", data_type: "integer", nullable: false }],
    [{ name: "id", data_type: "integer", nullable: true }],
  ])("拒绝缺失或变化的输出授权 %#", async (expectedOutput) => {
    await expect(plan(expectedOutput)).rejects.toThrow();
  });
  it("完整输出授权与本地定义一致时接受", async () => {
    expect(
      (await plan([{ name: "id", data_type: "integer", nullable: false }])).query,
    ).toMatchObject({ fixed_output: [{ name: "id", data_type: "integer", nullable: false }] });
  });
});

/** 使用本地过程配置读取替身，避免查询实际数据源。 */
function plan(expectedOutput: unknown) {
  return new QueryPlanner(
    {
      findEnabledBySourceId: async () => ({
        sourceId: "clinical",
        connectorKind: "sqlserver",
        secretRef: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 10,
        costLimit: 1,
      }),
    },
    {
      findQueryableBySourceIdAndObjectId: async () => ({
        sourceId: "clinical",
        objectId: "report",
        objectKind: "stored_procedure",
        nativeObjectName: "report",
        isQueryable: true,
        isDiscoverable: true,
        queryCapabilities: {},
        procedureDefinition: {
          query_parameters: [],
          columns: [{ name: "id", data_type: "integer", nullable: false }],
        },
      }),
    },
    { verify: async () => {} },
  ).plan({
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
      source_id: "clinical",
      from: { object_id: "report", alias: "r" },
      parameters: [],
      ...(expectedOutput === undefined ? {} : { expected_output: expectedOutput }),
    },
  });
}
