import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  HttpApiConnector,
  type ApiDatasetMappingLookup,
} from "../../src/connectors/http-api-connector";
import type { ApiDatasetMapping, DataSourceConfig } from "../../src/metadata/metadata-records";

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
    parameterMappings: [{ name: "department", location: "query", key: "dept" }],
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

describe("HTTP API 连接器", () => {
  // BDD 场景：HTTP API 返回 JSON 数组；TDD 断言：固定请求映射和 JSONPath 结果转换为统一表格。
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
      });

      expect(result).toMatchObject({ row_count: 1, rows: [{ id: 1, name: "Alice" }] });
      await connector.close();
    } finally {
      await close(server);
    }
  });
});

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

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
