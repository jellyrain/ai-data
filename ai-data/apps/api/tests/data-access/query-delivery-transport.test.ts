import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { requestDataAccess } from "../../src/data-access/request-data-access";

describe("DAS 查询响应传输预算", () => {
  it("在 HTTP 接收期间拒绝过大的响应，并使用稳定的资源错误码", async () => {
    const upstream = Fastify();
    upstream.post("/internal/query", async () => ({ text: "中".repeat(1000) }));
    const address = await upstream.listen({ host: "127.0.0.1", port: 0 });
    try {
      await expect(
        requestDataAccess(
          `${address}/internal/query`,
          {},
          (data) => data,
          "test-token",
          "POST",
          undefined,
          { maxBytes: 100, timeoutMs: 1000 },
        ),
      ).rejects.toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
      await expect(
        requestDataAccess(
          `${address}/internal/query`,
          {},
          (data) => data,
          "test-token",
          "POST",
          undefined,
          { maxBytes: 10000, timeoutMs: 1000 },
        ),
      ).resolves.toHaveProperty("text");
    } finally {
      await upstream.close();
    }
  });
});
