import { describe, expect, it, vi } from "vitest";

import { HttpApiConnector } from "../../src/connectors/http-api-connector";
import { DatabaseConnector } from "../../src/connectors/database-connector";
import { sqlServerDialect } from "../../src/connectors/dialects/sqlserver-dialect";
import type { ApiDatasetMapping } from "../../src/connectors/api-dataset-mapping-types";
import type { ExecutableParameterizedQuery } from "../../src/connectors/executable-query";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const config: DataSourceConfig = {
  sourceId: "reports",
  connectorKind: "sqlserver",
  secretRef: "test",
  timeoutMs: 1000,
  connectionPoolLimit: 1,
  concurrencyLimit: 1,
  rowLimit: 10,
  costLimit: 10,
};
const query: ExecutableParameterizedQuery = {
  type: "parameterized_query",
  source_id: "reports",
  timeout_ms: 1000,
  row_limit: 10,
  from: {
    object_id: "visits",
    native_schema_name: "dbo",
    native_object_name: "visits",
    alias: "v",
  },
  parameters: [],
  fixed_output: [{ name: "id", data_type: "integer", nullable: false }],
};
const mapping: ApiDatasetMapping = {
  sourceId: "reports",
  objectId: "visits",
  request: {
    method: "GET",
    path: "/visits",
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

// 管理定义决定参数类型、默认值与固定输出；查询声明不能替换管理员定义。
describe("固定调用的可信输入输出", () => {
  it("HTTP 目录声明真实类型、必填和默认值，并标明完整输出", async () => {
    const connector = createHttp(mapping);
    try {
      expect(await connector.discoverCatalog()).toMatchObject([
        {
          has_complete_output: true,
          query_parameters: [
            { name: "department", data_type: "integer", required: true, default_value: 7 },
          ],
        },
      ]);
    } finally {
      await connector.close();
    }
  });

  it.each([
    [{ name: "department", data_type: "string", value: "7" }],
    [{ name: "unknown", data_type: "integer", value: 7 }],
    [
      { name: "department", data_type: "integer", value: 7 },
      { name: "department", data_type: "integer", value: 8 },
    ],
  ])("HTTP 在发请求前拒绝错误、未知或重复参数 %#", async (...parameters) => {
    const connector = createHttp(mapping);
    try {
      await expect(
        connector.execute({ ...query, parameters } as ExecutableParameterizedQuery),
      ).rejects.toThrow(/参数/);
    } finally {
      await connector.close();
    }
  });

  it("HTTP 必填参数没有默认值且调用省略时拒绝", async () => {
    const connector = createHttp({
      ...mapping,
      request: {
        ...mapping.request,
        parameterMappings: [
          {
            name: "department",
            location: "query",
            key: "dept",
            dataType: "integer",
            required: true,
          },
        ],
      },
    });
    try {
      await expect(connector.execute(query)).rejects.toThrow(/参数/);
    } finally {
      await connector.close();
    }
  });

  it.each([
    { columns: [{ name: "other", dataType: "int" }], rows: [{ other: 1 }] },
    { columns: [{ name: "id", dataType: "varchar" }], rows: [{ id: "1" }] },
    { columns: [{ name: "id", dataType: "int" }], rows: [{ id: null }] },
    { columns: [], rows: [] },
    {
      columns: [
        { name: "id", dataType: "int" },
        { name: "extra", dataType: "int" },
      ],
      rows: [],
    },
  ])("过程输出列、类型、可空性变化时拒绝 %#", async (result) => {
    const driver = { query: vi.fn().mockResolvedValue(result), close: vi.fn() };
    const connector = new DatabaseConnector(config, driver, sqlServerDialect);
    await expect(
      connector.execute({
        ...query,
        fixed_output: [{ name: "id", data_type: "integer", nullable: false }],
      } as ExecutableParameterizedQuery),
    ).rejects.toThrow(/固定输出/);
  });

  it("空结果保留经过核对的完整列定义", async () => {
    const connector = new DatabaseConnector(
      config,
      {
        query: vi.fn().mockResolvedValue({ columns: [{ name: "id", dataType: "int" }], rows: [] }),
        close: vi.fn(),
      },
      sqlServerDialect,
    );
    await expect(
      connector.execute({
        ...query,
        fixed_output: [{ name: "id", data_type: "integer", nullable: false }],
      } as ExecutableParameterizedQuery),
    ).resolves.toMatchObject({ columns: [{ name: "id", data_type: "integer" }], rows: [] });
  });
});

/** 使用不可达本地地址，参数拒绝必须发生在网络调用之前。 */
function createHttp(value: ApiDatasetMapping) {
  return new HttpApiConnector(
    config,
    { connectorKind: "http_api", baseUrl: "http://127.0.0.1:1", headers: {} },
    {
      findBySourceIdAndObjectId: async () => value,
      listBySourceId: async () => [value],
    },
  );
}
