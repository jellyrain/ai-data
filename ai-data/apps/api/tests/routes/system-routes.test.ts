import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import { registerSystemRoutes } from "../../src/routes/system-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import type { ApiConfig } from "../../src/config/api-config";

/** 探针测试使用的完整启动配置，只消费服务标识和健康检查结果。 */
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

/** 固定数据库探针结果，隔离系统路由响应与数据库连接实现。 */
function createHealthChecker(status: "healthy" | "unhealthy"): MetadataDatabaseHealthChecker {
  return { checkHealth: async () => status };
}

/** 系统模块只装配探针所需的配置和数据库健康能力。 */
function createSystemApp(status: "healthy" | "unhealthy") {
  const app = Fastify();
  registerContractErrorHandler(app);
  registerSystemRoutes(app, config, createHealthChecker(status));
  return app;
}

describe("API 系统路由", () => {
  it("返回健康和版本信息", async () => {
    const app = createSystemApp("unhealthy");

    const health = await app.inject({ method: "GET", url: "/health" });
    const version = await app.inject({ method: "GET", url: "/version" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "healthy", service_id: "ai-bi-api" });
    expect(version.json()).toEqual({ service_id: "ai-bi-api", service_version: "1.0.0" });
    await app.close();
  });

  it("在元数据库不健康时拒绝就绪", async () => {
    const app = createSystemApp("unhealthy");

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      dependencies: { metadata_database: "unhealthy" },
    });
    await app.close();
  });

  it("返回带请求 ID 的错误响应", async () => {
    const app = createSystemApp("healthy");

    const response = await app.inject({
      method: "GET",
      url: "/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND", request_id: expect.any(String) });
    await app.close();
  });
});
