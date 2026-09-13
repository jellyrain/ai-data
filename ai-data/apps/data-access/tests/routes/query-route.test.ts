import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InternalQueryVerifier } from "../../src/auth/internal-query-verifier";
import type { DataSourceConnector } from "../../src/connectors/connector";
import { QueryExecutionService } from "../../src/query-execution/query-execution-service";
import { QueryPlanner } from "../../src/query-planning/query-planner";
import { registerQueryRoute } from "../../src/routes/query-route";
import {
  createInternalToken,
  createSignedRequest,
  now,
  nowSeconds,
  publicPem,
} from "../support/internal-query-fixtures";

/** 路由、验签、规划和出口脱敏使用真实实现，连接器记录是否进入业务数据访问。 */
async function createQueryApp() {
  const execute = vi.fn<DataSourceConnector["execute"]>(async () => ({
    columns: [{ name: "phone", data_type: "string" }],
    rows: [{ phone: "13800138000" }],
    row_count: 1,
    truncated: false,
  }));
  const connector: DataSourceConnector = {
    sourceId: "clinical",
    kind: "sqlserver",
    execute,
    checkHealth: async () => ({
      source_id: "clinical",
      status: "healthy",
      checked_at: "2026-09-13 12:00:00",
    }),
    discoverCatalog: async () => [],
    close: async () => {},
  };
  const get = vi.fn(async () => connector);
  const planner = new QueryPlanner(
    {
      findEnabledBySourceId: async () => ({
        sourceId: "clinical",
        connectorKind: "sqlserver",
        secretRef: "test-source",
        targetDatabase: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 10,
        costLimit: 100,
      }),
    },
    {
      findQueryableBySourceIdAndObjectId: async () => ({
        sourceId: "clinical",
        objectId: "visit",
        objectKind: "table",
        nativeSchemaName: "dbo",
        nativeObjectName: "visit",
        isDiscoverable: true,
        isQueryable: true,
        queryCapabilities: {},
      }),
    },
    { verify: async () => undefined },
  );
  const app = Fastify({ logger: false });
  const write = vi.fn(async () => 1);
  registerQueryRoute(
    app,
    new QueryExecutionService(planner, { get }),
    await InternalQueryVerifier.create(publicPem),
    { write },
  );
  return { app, execute, get, write };
}

describe("DAS 查询接口授权边界", () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(async () => {
    await app?.close();
    vi.useRealTimers();
  });

  it("有效授权执行查询并应用后缀为零的脱敏规则", async () => {
    const harness = await createQueryApp();
    app = harness.app;
    const response = await app.inject({
      method: "POST",
      url: "/internal/query",
      payload: createSignedRequest(),
      headers: { authorization: `Bearer ${await createInternalToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().rows).toEqual([{ phone: "138********" }]);
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "executed", rowCount: 1 }),
    );
    expect(harness.write).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: response.headers["x-request-id"] }),
    );
  });

  it("解析 JSON 失败也记录匿名拒绝事件", async () => {
    const harness = await createQueryApp();
    app = harness.app;
    const response = await app.inject({
      method: "POST",
      url: "/internal/query",
      headers: { "content-type": "application/json" },
      payload: '{"access":',
    });
    expect(response.statusCode).toBe(400);
    expect(harness.write).toHaveBeenCalledOnce();
    expect(harness.write).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rejected", objectIds: [] }),
    );
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("调用方断开真实 HTTP 连接后取消执行并保留审计", async () => {
    const h = await createQueryApp();
    app = h.app;
    const started = pendingSignal();
    const completed = pendingSignal();
    const release = pendingSignal();
    let aborted = false;
    h.execute.mockImplementationOnce(async (_query, options) => {
      const onAbort = () => {
        aborted = true;
        release.resolve();
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      started.resolve();
      try {
        await release.promise;
      } finally {
        options?.signal?.removeEventListener("abort", onAbort);
      }
      return { columns: [], rows: [], row_count: 0, truncated: false };
    });
    h.write.mockImplementationOnce(async () => {
      completed.resolve();
      return 1;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = httpRequest(`${address}/internal/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await createInternalToken()}`,
      },
    });
    client.on("error", () => {});
    client.end(JSON.stringify(createSignedRequest()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started.promise;
      client.destroy();
      await Promise.race([
        completed.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("断开未传播到执行")), 1000);
        }),
      ]);
      expect(aborted).toBe(true);
      expect(h.write).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed", errorCode: "CANCELLED" }),
      );
    } finally {
      clearTimeout(timer);
      client.destroy();
      release.resolve();
    }
  });

  it.each(["授权到期", "缺少生效时间", "令牌尚未生效", "令牌过期", "受众错误", "请求被篡改"])(
    "%s 时在连接器访问前拒绝",
    async (scenario) => {
      const harness = await createQueryApp();
      app = harness.app;
      const request = createSignedRequest(
        scenario === "授权到期" ? { expires_at: "2026-09-13 12:00:00" } : {},
      );
      if (scenario === "请求被篡改") request.query.limit = 1;
      const token = await createInternalToken(
        scenario === "令牌尚未生效"
          ? { nbf: nowSeconds + 1 }
          : scenario === "令牌过期"
            ? { exp: nowSeconds }
            : scenario === "受众错误"
              ? { aud: "other-service" }
              : {},
        scenario === "缺少生效时间" ? ["nbf"] : [],
      );
      const response = await app.inject({
        method: "POST",
        url: "/internal/query",
        payload: request,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "UNAUTHORIZED",
        request_id: expect.any(String),
      });
      expect(harness.get).not.toHaveBeenCalled();
      expect(harness.execute).not.toHaveBeenCalled();
    },
  );
});

/** 手工结束在途替身，保持网络场景的清理路径可控。 */
function pendingSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
