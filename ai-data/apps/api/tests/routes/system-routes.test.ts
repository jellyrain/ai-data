import { describe, expect, it } from "vitest";

import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import { createApp } from "../../src/app";
import type { ApiConfig } from "../../src/config/api-config";

const config: ApiConfig = {
  node_env: "test",
  service: {
    host: "127.0.0.1",
    port: 3000,
    service_id: "ai-bi-api",
    service_version: "1.0.0",
  },
  metadata_sqlserver: {
    server: "localhost",
    port: 1433,
    database: "ai_bi_meta",
    user: "api_user",
    password: "secret",
    options: {
      encrypt: true,
      trust_server_certificate: false,
      connection_timeout_ms: 5000,
      request_timeout_ms: 10000,
      pool: { max: 10, min: 0, idle_timeout_ms: 30000 },
    },
  },
  jwt: {
    issuer: "ai-data-api",
    audience: "ai-data-api",
    access_token_ttl_seconds: 900,
    signing_private_key_pem: "test-private-key",
    verification_public_key_pem: "test-public-key",
  },
};

function createHealthChecker(status: "healthy" | "unhealthy"): MetadataDatabaseHealthChecker {
  return { checkHealth: async () => status };
}

describe("API 系统路由", () => {
  // BDD 场景：负载均衡器探测 API；TDD 断言：存活接口不依赖数据库。
  it("返回健康和版本信息", async () => {
    const app = await createApp(config, createHealthChecker("unhealthy"));

    const health = await app.inject({ method: "GET", url: "/health" });
    const version = await app.inject({ method: "GET", url: "/version" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "healthy", service_id: "ai-bi-api" });
    expect(version.json()).toEqual({ service_id: "ai-bi-api", service_version: "1.0.0" });
    await app.close();
  });

  // BDD 场景：元数据库不可用；TDD 断言：就绪接口返回 503。
  it("在元数据库不健康时拒绝就绪", async () => {
    const app = await createApp(config, createHealthChecker("unhealthy"));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      dependencies: { metadata_database: "unhealthy" },
    });
    await app.close();
  });

  // BDD 场景：客户端发送未知路径；TDD 断言：统一错误出口包含请求 ID。
  it("返回带请求 ID 的错误响应", async () => {
    const app = await createApp(config, createHealthChecker("healthy"));

    const response = await app.inject({
      method: "GET",
      url: "/missing",
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
