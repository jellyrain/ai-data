import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import type { CatalogReader } from "../../src/catalog/catalog-service";
import type { DasConfig } from "../../src/config/das-config";
import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

const config: DasConfig = {
  service: {
    host: "127.0.0.1",
    port: 3102,
    service_id: "data-access-test",
    service_version: "0.1.0",
  },
  api: {
    base_url: "http://127.0.0.1:3101",
    heartbeat_path: "/internal/data-access/heartbeat",
    jwt_verification_public_key_path: "./test-public.pem",
  },
  metadata_sqlserver: {
    server: "127.0.0.1",
    port: 1433,
    database: "das_meta_test",
    user: "das_service",
    password: "test-password",
    options: {
      encrypt: false,
      trust_server_certificate: true,
      connection_timeout_ms: 5000,
      request_timeout_ms: 15000,
      pool: {
        max: 10,
        min: 0,
        idle_timeout_ms: 30000,
      },
    },
  },
};

/** 构造无需真实 SQL Server 的元数据库健康检查替身。 */
function createHealthChecker(status: "healthy" | "unhealthy"): MetadataDatabaseHealthChecker {
  return {
    async checkHealth() {
      return status;
    },
  };
}

describe("DAS 健康检查路由", () => {
  // BDD 场景：DAS 元数据库正常；TDD 断言：服务可以接收后续内部请求。
  it("元数据库健康时返回 200", async () => {
    const app = createApp(
      config,
      createHealthChecker("healthy"),
      createCatalogReader(),
      createManagementApi(),
    );

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "healthy",
      service_id: "data-access-test",
    });
    await app.close();
  });

  // BDD 场景：DAS 元数据库不可用；TDD 断言：服务拒绝被调度为可用实例。
  it("元数据库不可用时返回 503", async () => {
    const app = createApp(
      config,
      createHealthChecker("unhealthy"),
      createCatalogReader(),
      createManagementApi(),
    );

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "unhealthy",
    });
    await app.close();
  });
});

/** 构造健康检查测试不使用的目录读取替身。 */
function createCatalogReader(): CatalogReader {
  return {
    async listBySourceId() {
      return [];
    },
  };
}

/** 构造健康检查测试不使用的数据源管理接口替身。 */
function createManagementApi() {
  return {
    async saveSharedCredentials() {
      return { secret_ref: "unused" };
    },
    async discoverDatabaseTargets() {
      return { databases: [] };
    },
    async saveDataSource() {
      return { source_id: "unused" };
    },
    async discoverSourceObjects() {
      return { items: [] };
    },
    async replaceSourceObjects() {
      return { source_id: "unused", object_count: 0 };
    },
  };
}
