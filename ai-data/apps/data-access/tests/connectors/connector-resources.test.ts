import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  DatabaseConnector,
  type DatabaseDriver,
  type DatabaseQueryResult,
} from "../../src/connectors/database-connector";
import { sqlServerDialect } from "../../src/connectors/dialects";
import { HttpApiConnector } from "../../src/connectors/http-api-connector";
import type { ApiDatasetMapping } from "../../src/connectors/api-dataset-mapping-types";
import type { ExecutableParameterizedQuery } from "../../src/connectors/executable-query";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const config: DataSourceConfig = {
  sourceId: "test",
  connectorKind: "sqlserver",
  secretRef: "test",
  targetDatabase: "reporting",
  timeoutMs: 1000,
  connectionPoolLimit: 1,
  concurrencyLimit: 1,
  rowLimit: 10,
  costLimit: 100,
};
const query: ExecutableParameterizedQuery = {
  type: "parameterized_query",
  source_id: "test",
  timeout_ms: 1000,
  row_limit: 10,
  from: { object_id: "report", native_object_name: "report", alias: "r" },
  parameters: [],
  fixed_output: [{ name: "id", data_type: "integer", nullable: false }],
};
const mapping: ApiDatasetMapping = {
  sourceId: "test",
  objectId: "report",
  request: { method: "GET", path: "/report", parameterMappings: [] },
  response: {
    mode: "list",
    path: "$.data[*]",
    fields: [{ name: "id", jsonPath: "$.id", dataType: "integer", nullable: false }],
  },
};

/** 本地慢 HTTP 服务记录响应关闭，用于核验 Axios 实际关闭连接。 */
async function httpFixture() {
  const responses: ServerResponse[] = [];
  let closed = 0;
  const server = createServer((_request, response) => {
    responses.push(response);
    response.once("close", () => {
      closed += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务没有监听 TCP 端口");
  const lookup = {
    async findBySourceIdAndObjectId() {
      return mapping;
    },
    async listBySourceId() {
      return [mapping];
    },
  };
  const connector = new HttpApiConnector(
    { ...config, connectorKind: "http_api" },
    { connectorKind: "http_api", baseUrl: `http://127.0.0.1:${address.port}`, headers: {} },
    lookup,
  );
  return {
    connector,
    responses,
    lookup,
    get closed() {
      return closed;
    },
    async close() {
      server.closeAllConnections();
      await connector.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("连接器端到端资源限制", () => {
  it("数据库执行接入有限队列并把信号和请求预算传给驱动，关闭等待驱动归还", async () => {
    let finish!: (value: DatabaseQueryResult) => void;
    const driver: DatabaseDriver = {
      query: vi.fn(
        () =>
          new Promise<DatabaseQueryResult>((resolve) => {
            finish = resolve;
          }),
      ),
      close: vi.fn(async () => {}),
    };
    const connector = new DatabaseConnector(config, driver, sqlServerDialect);
    const running = connector.execute({ ...query, timeout_ms: 200 });
    const runningOutcome = running.catch((error: unknown) => error);
    const queued = connector.execute(query);
    const queuedOutcome = queued.catch((error: unknown) => error);
    await expect(connector.execute(query)).rejects.toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
    expect(driver.query).toHaveBeenCalledTimes(1);
    expect(driver.query).toHaveBeenCalledWith(expect.any(String), [], {
      signal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
      resultBudget: { maxRows: 11, maxBytes: 32 * 1024 * 1024 },
    });
    const closing = connector.close();
    expect(await runningOutcome).toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
    expect(await queuedOutcome).toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
    expect(driver.close).not.toHaveBeenCalled();
    finish({ rows: [], columns: [{ name: "id", dataType: "integer", nullable: false }] });
    await closing;
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it("HTTP 请求级超时中断真实 socket，后续请求仍可成功执行", async () => {
    const fixture = await httpFixture();
    try {
      await expect(fixture.connector.execute({ ...query, timeout_ms: 50 })).rejects.toMatchObject({
        code: "QUERY_TIMEOUT",
      });
      await vi.waitFor(() => expect(fixture.closed).toBe(1));
      const next = fixture.connector.execute(query);
      await vi.waitFor(() => expect(fixture.responses).toHaveLength(2));
      fixture.responses[1]!.setHeader("content-type", "application/json");
      fixture.responses[1]!.end(JSON.stringify({ data: [{ id: 7 }] }));
      await expect(next).resolves.toMatchObject({ rows: [{ id: 7 }] });
    } finally {
      await fixture.close();
    }
  });

  it("HTTP 等待取消释放队列位置，在途取消关闭 socket，关闭拒绝等待者", async () => {
    const fixture = await httpFixture();
    try {
      const controller = new AbortController();
      const running = fixture.connector.execute(query, { signal: controller.signal });
      const runningOutcome = running.catch((error: unknown) => error);
      await vi.waitFor(() => expect(fixture.responses).toHaveLength(1));
      const queuedController = new AbortController();
      const queued = fixture.connector.execute(query, { signal: queuedController.signal });
      const queuedOutcome = queued.catch((error: unknown) => error);
      await expect(fixture.connector.execute(query)).rejects.toMatchObject({
        code: "QUERY_LIMIT_EXCEEDED",
      });
      queuedController.abort();
      expect(await queuedOutcome).toMatchObject({ code: "CANCELLED" });
      const next = fixture.connector.execute(query);
      const nextOutcome = next.catch((error: unknown) => error);
      controller.abort();
      expect(await runningOutcome).toMatchObject({ code: "CANCELLED" });
      await fixture.connector.close();
      expect(await nextOutcome).toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
      await vi.waitFor(() => expect(fixture.closed).toBe(1));
      expect(fixture.responses).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("HTTP 映射读取包含在总预算内，超时后的映射不能启动请求", async () => {
    const fixture = await httpFixture();
    try {
      let finish!: (value: ApiDatasetMapping) => void;
      fixture.lookup.findBySourceIdAndObjectId = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      await expect(fixture.connector.execute({ ...query, timeout_ms: 20 })).rejects.toMatchObject({
        code: "QUERY_TIMEOUT",
      });
      finish(mapping);
      await fixture.connector.close();
      expect(fixture.responses).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("HTTP 调用前固定输出与授权定义不符时拒绝，并保持外部请求数为零", async () => {
    const fixture = await httpFixture();
    try {
      await expect(
        fixture.connector.execute({
          ...query,
          fixed_output: [{ name: "id", data_type: "string", nullable: false }],
        }),
      ).rejects.toThrow("固定输出");
      expect(fixture.responses).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});
