import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import type { CatalogReader } from "../../src/catalog/catalog-service";
import type { DasConfig } from "../../src/config/das-config";
import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";
import type { DataSourceManagementApi } from "../../src/routes/data-source-management-route";
import { createServiceToken, createServiceVerifier } from "../support/service-auth-fixtures";

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
    registration_credential_path: "test-registration.jwt",
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
      pool: { max: 10, min: 0, idle_timeout_ms: 30000 },
    },
  },
};

// 管理服务由替身提供，用例检查路由转发、响应结构及失败消息转换。
describe("DAS 数据源管理接口", () => {
  it("返回共享凭据可访问的目标数据库", async () => {
    const calls: unknown[] = [];
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      {
        ...createManagementApi(),
        async discoverDatabaseTargets(input) {
          calls.push(input);
          return {
            databases: [{ name: "clinical_reporting", connect_target: "clinical_reporting" }],
          };
        },
      },
      undefined,
      undefined,
      await createServiceVerifier(),
    );

    const response = await app.inject({
      method: "POST",
      url: "/internal/admin/database-targets",
      payload: { secret_ref: "hospital-sqlserver-reader", connector_kind: "sqlserver" },
      headers: {
        authorization: `Bearer ${await createServiceToken("POST", "/internal/admin/database-targets", { secret_ref: "hospital-sqlserver-reader", connector_kind: "sqlserver" })}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      databases: [{ name: "clinical_reporting", connect_target: "clinical_reporting" }],
    });
    expect(calls).toEqual([
      { secret_ref: "hospital-sqlserver-reader", connector_kind: "sqlserver" },
    ]);
    await app.close();
  });

  it("管理失败时返回稳定错误消息", async () => {
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      {
        ...createManagementApi(),
        async discoverDatabaseTargets() {
          throw new Error("driver failed at 10.0.0.15");
        },
      },
      undefined,
      undefined,
      await createServiceVerifier(),
    );

    const response = await app.inject({
      method: "POST",
      url: "/internal/admin/database-targets",
      payload: { secret_ref: "hospital-sqlserver-reader", connector_kind: "sqlserver" },
      headers: {
        authorization: `Bearer ${await createServiceToken("POST", "/internal/admin/database-targets", { secret_ref: "hospital-sqlserver-reader", connector_kind: "sqlserver" })}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_INPUT",
      message: "数据源管理请求无效或无法完成",
    });
    await app.close();
  });
});

/** 构造无需真实 SQL Server 的健康检查替身。 */
function createHealthChecker(): MetadataDatabaseHealthChecker {
  return {
    async checkHealth() {
      return "healthy";
    },
  };
}

/** 构造本路由测试不使用的目录读取替身。 */
function createCatalogReader(): CatalogReader {
  return {
    async listBySourceId() {
      return [];
    },
  };
}

/** 构造数据源管理路由的最小服务替身。 */
function createManagementApi(): DataSourceManagementApi {
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
