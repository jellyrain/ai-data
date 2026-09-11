import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import type { DasConfig } from "../../src/config/das-config";
import type { CatalogReader } from "../../src/catalog/catalog-service";
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
      pool: { max: 10, min: 0, idle_timeout_ms: 30000 },
    },
  },
};

describe("DAS 目录接口", () => {
  // BDD 场景：API 请求一个数据源的目录；TDD 断言：返回 DAS 已筛选的统一数据集。
  it("返回指定数据源的目录", async () => {
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      createManagementApi(),
    );

    const response = await app.inject({
      method: "POST",
      url: "/internal/catalog",
      payload: { source_id: "clinical_reporting" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          source_id: "clinical_reporting",
          object_id: "patient_records",
          name: "patient_records",
          kind: "table",
          columns: [],
          query_parameters: [],
        },
      ],
    });
    await app.close();
  });

  // BDD 场景：调用方附带合同外字段；TDD 断言：目录接口拒绝未声明的请求结构。
  it("拒绝合同外字段", async () => {
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      createManagementApi(),
    );

    const response = await app.inject({
      method: "POST",
      url: "/internal/catalog",
      payload: { source_id: "clinical_reporting", include_disabled: true },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

/** 构造无需真实 SQL Server 的元数据库健康检查替身。 */
function createHealthChecker(): MetadataDatabaseHealthChecker {
  return {
    async checkHealth() {
      return "healthy";
    },
  };
}

/** 构造目录读取替身。 */
function createCatalogReader(): CatalogReader {
  return {
    async listBySourceId() {
      return [
        {
          source_id: "clinical_reporting",
          object_id: "patient_records",
          name: "patient_records",
          kind: "table",
          columns: [],
          query_parameters: [],
        },
      ];
    },
  };
}

/** 构造本目录路由测试不使用的数据源管理接口替身。 */
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
