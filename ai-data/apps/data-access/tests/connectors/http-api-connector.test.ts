import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  HttpApiConnector,
  type ApiDatasetMappingLookup,
} from "../../src/connectors/http-api-connector";
import type { ApiDatasetMapping } from "../../src/connectors/api-dataset-mapping-types";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const config: DataSourceConfig = {
  sourceId: "clinical_api",
  connectorKind: "http_api",
  secretRef: "secret-clinical-api",
  timeoutMs: 15000,
  connectionPoolLimit: 4,
  concurrencyLimit: 2,
  rowLimit: 100,
  costLimit: 50000,
};

const mapping: ApiDatasetMapping = {
  sourceId: "clinical_api",
  objectId: "patients",
  request: {
    method: "GET",
    path: "/patients",
    parameterMappings: [
      { name: "department", location: "query", key: "dept", dataType: "string", required: false },
    ],
  },
  response: {
    mode: "list",
    path: "$.data[*]",
    fields: [
      { name: "id", jsonPath: "$.id", dataType: "integer", nullable: false },
      { name: "name", jsonPath: "$.name", dataType: "string", nullable: true },
    ],
  },
};

// 以本地 HTTP 服务返回固定 JSON，同时核对实际请求参数与映射后的结果行。
describe("HTTP API 连接器", () => {
  it("调用省略参数时绑定管理员默认值，空结果仍返回固定列", async () => {
    let observedUrl: string | undefined;
    const server = createServer((request, response) => {
      observedUrl = request.url;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
    });
    const port = await listen(server);
    const connector = new HttpApiConnector(
      config,
      { connectorKind: "http_api", baseUrl: `http://127.0.0.1:${port}`, headers: {} },
      createLookup({
        ...mapping,
        request: {
          ...mapping.request,
          parameterMappings: [
            {
              name: "department",
              dataType: "integer",
              required: true,
              defaultValue: 7,
              location: "query",
              key: "dept",
            },
          ],
        },
      }),
    );
    try {
      expect(
        await connector.execute({
          type: "parameterized_query",
          source_id: config.sourceId,
          timeout_ms: config.timeoutMs,
          row_limit: 10,
          from: { object_id: "patients", native_object_name: "patients", alias: "p" },
          parameters: [],
          fixed_output: [
            { name: "id", data_type: "integer", nullable: false },
            { name: "name", data_type: "string", nullable: true },
          ],
        }),
      ).toMatchObject({
        columns: [
          { name: "id", data_type: "integer" },
          { name: "name", data_type: "string" },
        ],
        rows: [],
        row_count: 0,
      });
      expect(observedUrl).toBe("/patients?dept=7");
    } finally {
      await connector.close();
      await close(server);
    }
  });
  it.each([
    { dataType: "integer" as const, value: "12", expected: 12 },
    { dataType: "decimal" as const, value: "12.5", expected: 12.5 },
    { dataType: "boolean" as const, value: "false", expected: false },
    { dataType: "date" as const, value: "2026-09-13", expected: "2026-09-13" },
    {
      dataType: "datetime" as const,
      value: "2026-09-12T18:00:00Z",
      expected: "2026-09-13 02:00:00",
    },
    { dataType: "buffer" as const, value: "YWJj", expected: "YWJj" },
    { dataType: "integer" as const, value: null, expected: null },
  ])("按 $dataType 映射转换结果并执行 JSON 输出", async ({ dataType, value, expected }) => {
    const result = await executeMappedValue(value, dataType, true);
    expect(JSON.parse(JSON.stringify(result.rows))).toEqual([{ id: expected }]);
  });

  it.each([null, undefined])("不可空字段为 %s 时拒绝映射", async (value) => {
    await expect(executeMappedValue(value, "integer", false)).rejects.toThrow(
      "HTTP API 字段映射缺少必填值: id",
    );
  });

  it.each(["12x", "", "9007199254740993", {}])(
    "integer 字段不能转换时明确拒绝 %#",
    async (value) => {
      await expect(executeMappedValue(value, "integer", true)).rejects.toThrow(
        "结果字段 id 无法转换为 integer",
      );
    },
  );
  it("执行虚拟表并映射结果", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/patients?dept=cardiology");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: 1, name: "Alice" }] }));
    });
    const port = await listen(server);

    try {
      const connector = new HttpApiConnector(
        config,
        { connectorKind: "http_api", baseUrl: `http://127.0.0.1:${port}`, headers: {} },
        createLookup(mapping),
      );
      const result = await connector.execute({
        type: "parameterized_query",
        source_id: config.sourceId,
        timeout_ms: config.timeoutMs,
        row_limit: 10,
        from: {
          object_id: "patients",
          native_object_name: "patients",
          alias: "p",
        },
        parameters: [{ name: "department", data_type: "string", value: "cardiology" }],
        fixed_output: [
          { name: "id", data_type: "integer", nullable: false },
          { name: "name", data_type: "string", nullable: true },
        ],
      });

      expect(result).toMatchObject({ row_count: 1, rows: [{ id: 1, name: "Alice" }] });
      await connector.close();
    } finally {
      await close(server);
    }
  });
});

/** 使用回环 HTTP 响应验收字段映射，确保连接与服务在成功和失败路径都释放。 */
async function executeMappedValue(
  value: unknown,
  dataType: ApiDatasetMapping["response"]["fields"][number]["dataType"],
  nullable: boolean,
) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: value }] }));
  });
  const port = await listen(server);
  const connector = new HttpApiConnector(
    config,
    { connectorKind: "http_api", baseUrl: `http://127.0.0.1:${port}`, headers: {} },
    createLookup({
      ...mapping,
      response: {
        ...mapping.response,
        fields: [{ name: "id", jsonPath: "$.id", dataType, nullable }],
      },
    }),
  );
  try {
    return await connector.execute({
      type: "parameterized_query",
      source_id: config.sourceId,
      timeout_ms: config.timeoutMs,
      row_limit: 10,
      from: { object_id: "patients", native_object_name: "patients", alias: "p" },
      parameters: [],
      fixed_output: [{ name: "id", data_type: dataType, nullable }],
    });
  } finally {
    await connector.close();
    await close(server);
  }
}

/** 固定虚拟表映射的读取替身，供连接器组装实际 HTTP 请求。 */
function createLookup(value: ApiDatasetMapping): ApiDatasetMappingLookup {
  return {
    async findBySourceIdAndObjectId() {
      return value;
    },
    async listBySourceId() {
      return [value];
    },
  };
}

/** 在回环地址申请临时端口，避免测试依赖固定端口空闲。 */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

/** 等待本地测试服务关闭，将关闭异常传回测试。 */
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
