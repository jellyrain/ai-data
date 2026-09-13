import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { dataAccessQueryRequestSchema } from "@ai-data/contracts";

import { DataAccessQueryClient } from "../../src/data-access/data-access-query-client";
import { registerQueryRoutes } from "../../src/routes/query-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { createApiDependencies } from "../support/api-fixtures";

// API 与上游替身各自监听回环端口，用实际断开验证浏览器至 DAS HTTP 请求的取消传播。
describe("查询传输取消", () => {
  it("用户断开后 API 中断在途 DAS 请求", async () => {
    const upstream = Fastify();
    const api = Fastify();
    const started = pendingSignal();
    const closed = pendingSignal();
    const release = pendingSignal();
    upstream.post("/internal/query", async (_request, reply) => {
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) closed.resolve();
      });
      started.resolve();
      await release.promise;
      return { columns: [], rows: [], row_count: 0, truncated: false };
    });
    const upstreamAddress = await upstream.listen({ host: "127.0.0.1", port: 0 });
    const client = new DataAccessQueryClient({
      listHealthyServices: async () => [
        {
          serviceId: "das",
          serviceUrl: upstreamAddress,
          serviceVersion: "1",
          status: "healthy",
          lastHeartbeatAt: new Date(),
          message: null,
          sources: [
            { source_id: "clinical", status: "healthy", checked_at: "2026-09-13 12:00:00" },
          ],
        },
      ],
    });
    const authorized = {
      token: "test-internal-token",
      request: dataAccessQueryRequestSchema.parse({
        access: {
          user_id: "u",
          organization_id: "o",
          analysis_run_id: "r",
          policy_version: 1,
          expires_at: "2026-09-13 12:00:00",
        },
        query: {
          type: "relational_query",
          source_id: "clinical",
          from: { object_id: "visit", alias: "v" },
          select: [{ field: "v.id" }],
        },
        signature: "test-signature",
      }),
    };
    registerContractErrorHandler(api);
    registerQueryRoutes(
      api,
      createApiDependencies().auth,
      { authorize: async () => authorized },
      client,
    );
    const address = await api.listen({ host: "127.0.0.1", port: 0 });
    const browser = httpRequest(`${address}/query`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-user-token" },
    });
    browser.on("error", () => {});
    browser.end("{}");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("请求未到达上游")), 1500);
        }),
      ]);
      clearTimeout(timer);
      browser.destroy();
      await expect(
        Promise.race([
          closed.promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("上游连接未取消")), 1500);
          }),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
      browser.destroy();
      release.resolve();
      await api.close();
      await upstream.close();
    }
  });
});

/** 由网络事件和 finally 清理分别结束等待，避免保留悬挂请求。 */
function pendingSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
