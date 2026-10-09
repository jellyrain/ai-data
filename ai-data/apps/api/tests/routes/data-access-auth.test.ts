import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { context, createApiDependencies } from "../support/api-fixtures";
import { createServiceJwt } from "../support/service-auth-fixtures";
import { DataAccessSessionService } from "../../src/data-access/data-access-session-service";
import { InMemoryDataAccessServiceRegistry } from "../../src/data-access/data-access-registry";
import { managementOperations } from "../../src/data-access/data-access-management-client";

const heartbeat = {
  service_id: "das-test",
  service_port: 3102,
  service_protocol: "http",
  status: "healthy",
  sent_at: "2026-09-13 12:00:00",
  sources: [],
};

/** 路由、验签和会话状态使用真实实现，持久化使用内存仓储。 */
async function setup() {
  const dependencies = createApiDependencies();
  const raw = new InMemoryDataAccessServiceRegistry();
  const registry = new DataAccessSessionService(raw, await createServiceJwt(), [
    {
      service_id: "das-test",
      credential_version: 1,
      enabled: true,
      registration_secret: "s".repeat(43),
    },
  ]);
  const execute = vi.fn(async () => ({ source_id: "source" }));
  const app = await createApp({
    ...dependencies,
    dataAccess: {
      ...dependencies.dataAccess,
      registry,
      managementClient: {
        connection: vi.fn(async () => ({ items: [] })),
        sqlServerTransport: vi.fn(async () => {
          throw new Error("未配置连接参数测试");
        }),
        execute,
        read: dependencies.dataAccess.managementClient.read,
      },
    },
  });
  app.log.level = "silent";
  return { app, dependencies, registry, raw, execute };
}

describe("API 的 DAS 入口认证", () => {
  it("实例凭配置密钥领取 JWT 并接入，使用服务身份完成认证", async () => {
    const { app, registry, dependencies } = await setup();
    try {
      const issued = await app.inject({
        method: "POST",
        url: "/internal/data-access/credential",
        headers: { authorization: `Bearer ${"s".repeat(43)}` },
        payload: { service_id: "das-test" },
      });
      expect(issued.statusCode).toBe(200);
      expect(issued.headers["cache-control"]).toBe("no-store");
      expect(issued.json()).toMatchObject({
        service_id: "das-test",
        credential: expect.any(String),
      });
      expect(dependencies.auth.loadContext).not.toHaveBeenCalled();
      const registered = await app.inject({
        method: "POST",
        url: "/internal/data-access/register",
        headers: { authorization: `Bearer ${issued.json<{ credential: string }>().credential}` },
        payload: heartbeat,
      });
      expect(registered.statusCode).toBe(200);
      expect(await registry.listHealthyServices()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  it.each(["missing", "wrong", "unknown", "extra", "empty"])(
    "拒绝 %s 的自动领取请求",
    async (scenario) => {
      const { app, registry } = await setup();
      try {
        const response = await app.inject({
          method: "POST",
          url: "/internal/data-access/credential",
          headers:
            scenario === "missing"
              ? {}
              : {
                  authorization: `Bearer ${scenario === "wrong" ? "x".repeat(43) : "s".repeat(43)}`,
                },
          payload: {
            service_id: scenario === "unknown" ? "unknown" : scenario === "empty" ? "" : "das-test",
            ...(scenario === "extra" ? { credential_version: 999 } : {}),
          },
        });
        expect(response.statusCode).toBe(["extra", "empty"].includes(scenario) ? 400 : 401);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toContain("s".repeat(43));
        expect(await registry.listHealthyServices()).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  it.each(["/internal/data-access/services", "/internal/data-access/catalog/clinical"])(
    "管理读取 %s 要求登录身份",
    async (url) => {
      const dependencies = createApiDependencies();
      const app = await createApp(dependencies);
      app.log.level = "silent";
      try {
        const response = await app.inject({ url });
        expect(response.statusCode).toBe(401);
        expect(dependencies.dataAccess.registry.listHealthyServices).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("未建立会话的心跳不能登记实例", async () => {
    const dependencies = createApiDependencies();
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/internal/data-access/heartbeat",
        payload: {
          service_id: "das-test",
          service_port: 3102,
          service_protocol: "http",
          status: "healthy",
          sent_at: "2026-09-13 12:00:00",
          sources: [],
        },
      });
      expect(response.statusCode).toBe(401);
      expect(dependencies.dataAccess.registry.heartbeat).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("管理员领取凭证后完成首次注册和会话心跳，实例身份与凭证绑定", async () => {
    const { app, registry, raw } = await setup();
    try {
      const issued = await app.inject({
        method: "POST",
        url: "/admin/data-access/services/das-test/credential",
        headers: { authorization: "Bearer admin" },
      });
      expect(issued.statusCode).toBe(200);
      expect(issued.headers["cache-control"]).toBe("no-store");
      const credential = issued.json<{ credential: string }>().credential;
      const register = await app.inject({
        method: "POST",
        url: "/internal/data-access/register",
        headers: { authorization: `Bearer ${credential}` },
        payload: heartbeat,
      });
      expect(register.statusCode).toBe(200);
      expect(register.headers["cache-control"]).toBe("no-store");
      const token = register.json<{ session_token: string }>().session_token;
      const response = await app.inject({
        method: "POST",
        url: "/internal/data-access/heartbeat",
        headers: { authorization: `Bearer ${token}` },
        payload: heartbeat,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ service_id: "das-test" });
      expect(await registry.listHealthyServices()).toHaveLength(1);
      const write = vi.spyOn(raw, "registerHeartbeat");
      const forged = await app.inject({
        method: "POST",
        url: "/internal/data-access/register",
        headers: { authorization: `Bearer ${credential}` },
        payload: { ...heartbeat, service_id: "another-das" },
      });
      expect(forged.statusCode).toBe(401);
      const changed = await app.inject({
        method: "POST",
        url: "/internal/data-access/heartbeat",
        headers: { authorization: `Bearer ${token}` },
        payload: { ...heartbeat, service_port: 9999 },
      });
      expect(changed.statusCode).toBe(401);
      expect(write).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(Object.entries(managementOperations))(
    "管理代理 %s 先校验用户权限，再调用已注册实例",
    async (operation, endpoint) => {
      const { app, dependencies, registry, execute } = await setup();
      const handler =
        operation === "data-sources" || operation === "data-sources/delete"
          ? dependencies.dataAccess.sourceLifecycle.execute.mockResolvedValue({
              source_id: "source",
            })
          : execute;
      try {
        await registry.register(
          heartbeat as Parameters<typeof registry.register>[0],
          "http://127.0.0.1:3102",
          await registry.issueCredential("das-test"),
        );
        dependencies.auth.loadContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
        const request = {
          method: endpoint.method,
          url: `/admin/data-access/services/das-test/${operation}`,
          headers: { authorization: "Bearer user" },
          payload: { source_id: "source" },
        };
        expect((await app.inject(request)).statusCode).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        dependencies.auth.loadContext.mockResolvedValue({
          ...context,
          roles: [],
          permissions: ["data-access:manage"],
        });
        expect((await app.inject(request)).statusCode).toBe(200);
        expect(handler).toHaveBeenCalledWith(
          "das-test",
          "http://127.0.0.1:3102",
          operation,
          request.payload,
        );
      } finally {
        await app.close();
      }
    },
  );

  it("实例管理权限不能领取接入凭证", async () => {
    const { app, dependencies } = await setup();
    dependencies.auth.loadContext.mockResolvedValue({
      ...context,
      roles: [],
      permissions: ["data-access:manage"],
    });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/data-access/services/das-test/credential",
            headers: { authorization: "Bearer user" },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
