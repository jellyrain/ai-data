import { connectionManagementFixture } from "../support/connection-management-fixture";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app";
import type { CatalogReader } from "../../src/catalog/catalog-service";
import type { DasConfig } from "../../src/config/das-config";
import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";
import type { DataSourceManagementApi } from "../../src/routes/data-source-management-route";
import { createServiceToken, createServiceVerifier } from "../support/service-auth-fixtures";
import { ManagementConflict } from "../../src/data-sources/management-conflict";

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
  it("删除必须签名且参数完整，冲突返回 409", async () => {
    const api = createManagementApi();
    const path = "/internal/admin/data-sources/delete";
    const body = {
      source_id: "clinical",
      expected_revision: "a".repeat(64),
      expected_objects_revision: "b".repeat(64),
    };
    let calls = 0;
    api.deleteDataSource = async (input) => {
      expect(input).toEqual(body);
      calls++;
      return { source_id: "clinical" };
    };
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      api,
      undefined,
      undefined,
      await createServiceVerifier(),
    );
    app.log.level = "silent";
    const request = async (payload: Record<string, unknown>, signed = true) =>
      app.inject({
        method: "POST",
        url: path,
        payload,
        headers: signed
          ? { authorization: `Bearer ${await createServiceToken("POST", path, payload)}` }
          : {},
      });
    try {
      expect((await request(body, false)).statusCode).toBe(401);
      expect((await request({ source_id: "clinical" })).statusCode).toBe(400);
      expect(calls).toBe(0);
      const response = await request(body);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ source_id: "clinical" });
      api.deleteDataSource = async () => {
        throw new ManagementConflict();
      };
      expect((await request(body)).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("保存前连接测试要求签名，转发当前参数且隐藏驱动失败详情", async () => {
    const api = createManagementApi();
    const body = {
      connector_kind: "sqlserver",
      host: "draft.test",
      port: 1433,
      user: "reader",
      password: "private-test-password",
    };
    const path = "/internal/admin/database-connections/test";
    let seen: unknown;
    api.connections.testDraft = async (value) => {
      seen = value;
      return { databases: [{ name: "business", connect_target: "business" }] };
    };
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      api,
      undefined,
      undefined,
      await createServiceVerifier(),
    );
    app.log.level = "silent";
    const request = async (payload: unknown, signed = true) =>
      app.inject({
        method: "POST",
        url: path,
        payload: payload as Record<string, unknown>,
        headers: signed
          ? { authorization: `Bearer ${await createServiceToken("POST", path, payload)}` }
          : {},
      });
    try {
      expect((await request(body, false)).statusCode).toBe(401);
      const success = await request(body);
      expect(success.statusCode).toBe(200);
      expect(success.headers["cache-control"]).toBe("no-store");
      expect(seen).toEqual(body);
      expect(success.body).not.toContain(body.password);
      expect((await request({ ...body, password: "" })).statusCode).toBe(400);
      api.connections.testDraft = async () => {
        throw new Error(`driver failed ${body.password} ${body.host}`);
      };
      const failure = await request(body);
      expect(failure.statusCode).toBe(400);
      expect(failure.json().code).toBe("INVALID_INPUT");
      expect(failure.body).not.toMatch(/private-test-password|draft\.test/);
    } finally {
      await app.close();
    }
  });
  it.each(["reader", "医院业务库"])("连接 %s 校验签名、路径解码及管理错误码", async (id) => {
    const { DatabaseConnectionError } =
      await import("../../src/data-sources/database-connection-service");
    const api = createManagementApi();
    const state = {
      secret_ref: id,
      connector_kind: "sqlserver" as const,
      host: "sql.test",
      port: 1433,
      user: "reader",
      source_ids: ["clinical"],
      revision: "a".repeat(64),
    };
    api.connections = {
      ...connectionManagementFixture(),
      get: async (ref) => {
        expect(ref).toBe(id);
        return state;
      },
      remove: async () => {
        throw new DatabaseConnectionError("CONFLICT", "连接仍被使用");
      },
    };
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      api,
      undefined,
      undefined,
      await createServiceVerifier(),
    );
    app.log.level = "silent";
    const path = `/internal/admin/database-connections/${encodeURIComponent(id)}`;
    try {
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      const result = await app.inject({
        url: path,
        headers: { authorization: `Bearer ${await createServiceToken("GET", path, undefined)}` },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual(state);
      expect(result.headers["cache-control"]).toBe("no-store");
      const body = { expected_revision: state.revision };
      expect(
        (
          await app.inject({
            method: "POST",
            url: path + "/delete",
            payload: body,
            headers: {
              authorization: `Bearer ${await createServiceToken("POST", path + "/delete", body)}`,
            },
          })
        ).statusCode,
      ).toBe(409);
      api.connections.get = async () => {
        throw new DatabaseConnectionError("NOT_FOUND", "数据库连接不存在");
      };
      expect(
        (
          await app.inject({
            url: path,
            headers: {
              authorization: `Bearer ${await createServiceToken("GET", path, undefined)}`,
            },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("连接参数写入后的回读故障标记为服务失败，供 Web 核对保存状态", async () => {
    const api = createManagementApi();
    api.saveSqlServerTransport = async () => {
      throw new Error("saved but readback unavailable private-detail");
    };
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      api,
      undefined,
      undefined,
      await createServiceVerifier(),
    );
    app.log.level = "silent";
    try {
      const path = "/internal/admin/data-source-secrets/reader/sqlserver-transport";
      const body = {
        expected_revision: "a".repeat(64),
        sqlserver_transport: { encrypt: true, trust_server_certificate: true },
      };
      const response = await app.inject({
        method: "PUT",
        url: path,
        payload: body,
        headers: { authorization: `Bearer ${await createServiceToken("PUT", path, body)}` },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.body).not.toContain("private-detail");
    } finally {
      await app.close();
    }
  });
  it("连接选项读写校验签名和公开合同，证书失败返回脱敏专用错误", async () => {
    const api = createManagementApi();
    const state = {
      secret_ref: "reader",
      connector_kind: "sqlserver" as const,
      sqlserver_transport: { encrypt: true, trust_server_certificate: true },
      origin: "credential" as const,
      revision: "a".repeat(64),
      sources: [],
    };
    api.getSqlServerTransport = async () => state;
    api.saveSqlServerTransport = async () => state;
    api.discoverDatabaseTargets = async () => {
      throw new Error("self-signed certificate private-password sql.test");
    };
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      api,
      undefined,
      undefined,
      await createServiceVerifier(),
    );
    try {
      const path = "/internal/admin/data-source-secrets/reader/sqlserver-transport";
      for (const method of ["GET", "PUT"] as const) {
        const body =
          method === "PUT"
            ? { expected_revision: "a".repeat(64), sqlserver_transport: state.sqlserver_transport }
            : undefined;
        const unsigned = await app.inject({
          method,
          url: path,
          ...(body ? { payload: body } : {}),
        });
        expect(unsigned.statusCode).toBe(401);
        const response = await app.inject({
          method,
          url: path,
          ...(body ? { payload: body } : {}),
          headers: { authorization: `Bearer ${await createServiceToken(method, path, body)}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual(state);
      }
      const path2 = "/internal/admin/database-targets",
        body = { secret_ref: "reader", connector_kind: "sqlserver" };
      const response = await app.inject({
        method: "POST",
        url: path2,
        payload: body,
        headers: { authorization: `Bearer ${await createServiceToken("POST", path2, body)}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("DATA_SOURCE_CERTIFICATE_INVALID");
      expect(response.body).not.toMatch(/private-password|sql\.test/);
    } finally {
      await app.close();
    }
  });
  it("签名 GET 读取停用源的公开配置，响应禁止缓存", async () => {
    const api = createManagementApi();
    const app = createApp(
      config,
      createHealthChecker(),
      createCatalogReader(),
      api,
      undefined,
      undefined,
      await createServiceVerifier(),
    );
    const path = "/internal/admin/data-sources/disabled";
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${await createServiceToken("GET", path, undefined)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ config: null, revision: "a".repeat(64) });
    const forged = await app.inject({
      method: "GET",
      url: "/internal/admin/data-sources/other",
      headers: { authorization: `Bearer ${await createServiceToken("GET", path, undefined)}` },
    });
    expect(forged.statusCode).toBe(403);
    await app.close();
  });
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
    connections: connectionManagementFixture(),
    async listDataSources() {
      return { items: [] };
    },
    async getDataSource() {
      return { config: null, revision: "a".repeat(64) };
    },
    getSqlServerTransport: async () => {
      throw new Error("测试未配置连接参数读取");
    },
    saveSqlServerTransport: async () => {
      throw new Error("测试未配置连接参数更新");
    },
    async listSecretReferences() {
      return { items: [] };
    },
    async getSourceObjects() {
      return { items: [], revision: "a".repeat(64) };
    },
    async saveSharedCredentials() {
      return { secret_ref: "unused" };
    },
    async discoverDatabaseTargets() {
      return { databases: [] };
    },
    async saveDataSource() {
      return { source_id: "unused" };
    },
    async deleteDataSource() {
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
