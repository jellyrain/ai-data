import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contractErrorSchema, type ContractErrorCode } from "@ai-data/contracts";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { registerAuthRoutes } from "../../src/routes/auth-routes";
import { registerCatalogRoutes } from "../../src/routes/catalog-routes";
import { registerConversationRoutes } from "../../src/routes/conversation-routes";
import { registerUserAdminRoutes } from "../../src/routes/user-admin-routes";
import { registerQueryRoutes } from "../../src/routes/query-routes";
import { QueryAuthorizationError } from "../../src/query/query-authorization-service";
import { context, createApiDependencies } from "../support/api-fixtures";

const applications: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

/** 直接注册路由模块，使响应断言不依赖生产应用的装配方式。 */
function setup() {
  const app = Fastify();
  applications.push(app);
  const dependencies = createApiDependencies();
  registerContractErrorHandler(app);
  registerAuthRoutes(app, dependencies.auth, false);
  registerCatalogRoutes(
    app,
    dependencies.auth,
    dependencies.catalog.service,
    dependencies.catalog.permissions,
  );
  registerConversationRoutes(app, dependencies.auth, dependencies.conversations);
  registerUserAdminRoutes(app, dependencies.auth);
  registerQueryRoutes(
    app,
    dependencies.auth,
    dependencies.query.authorization,
    dependencies.query.client,
  );
  return { app, dependencies };
}

describe("API 错误合同", () => {
  it("刷新 Cookie 编码损坏时返回输入错误", async () => {
    const { app } = setup();
    const result = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: "refresh_token=%E0%A4%A" },
      payload: {},
    });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({ code: "INVALID_INPUT", request_id: expect.any(String) });
  });

  it.each([
    ["INVALID_INPUT", 400],
    ["AUTHENTICATION_FAILED", 401],
    ["UNAUTHORIZED", 403],
    ["UNAUTHORIZED_OBJECT", 403],
    ["UNAUTHORIZED_COLUMN", 403],
    ["POLICY_REJECTED", 403],
    ["UNSUPPORTED_QUERY", 400],
    ["QUERY_LIMIT_EXCEEDED", 400],
    ["QUERY_TIMEOUT", 504],
    ["DATA_SOURCE_UNAVAILABLE", 503],
    ["RATE_LIMITED", 429],
    ["NOT_FOUND", 404],
    ["CANCELLED", 409],
    ["INTERNAL_ERROR", 500],
  ] satisfies [ContractErrorCode, number][])(
    "%s 在目录和查询路由都映射为 %i，分类不依赖提示文案",
    async (code, status) => {
      const { app, dependencies } = setup();
      dependencies.catalog.service.listAuthorized.mockRejectedValue(
        new QueryAuthorizationError("目录提示已调整", code),
      );
      dependencies.query.authorization.authorize.mockRejectedValue(
        new QueryAuthorizationError("查询提示已调整", code),
      );
      for (const [method, url] of [
        ["GET", "/catalog/datasets/source"],
        ["POST", "/query"],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { authorization: "Bearer test" },
          ...(method === "POST" ? { payload: {} } : {}),
        });
        expect(response.statusCode).toBe(status);
        expect(contractErrorSchema.parse(response.json())).toMatchObject({
          code,
          request_id: expect.any(String),
        });
        expect(response.json().request_id.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(["/auth/me", "/conversations", "/catalog/datasets/source", "/admin/users"])(
    "%s 的未知依赖异常返回可追踪的内部错误",
    async (url) => {
      const { app, dependencies } = setup();
      const error = new Error("database-password-secret");
      dependencies.auth.loadContext.mockRejectedValue(error);
      const log = vi.spyOn(app.log, "error");
      const response = await app.inject({ url, headers: { authorization: "Bearer test" } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        code: "INTERNAL_ERROR",
        message: "服务内部错误",
        request_id: expect.any(String),
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ err: error, request_id: response.json().request_id }),
        expect.any(String),
      );
    },
  );

  it.each(["/auth/me", "/conversations", "/admin/users", "/catalog/datasets/source"])(
    "%s 缺少令牌统一返回认证失败",
    async (url) => {
      const { app } = setup();
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "AUTHENTICATION_FAILED",
        request_id: expect.any(String),
      });
    },
  );

  it.each([
    ["/auth/login", {}],
    ["/conversations", { title: "" }],
    ["/admin/users", { username: "a" }],
  ])("输入校验失败 %s 返回 400", async (url, payload) => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { authorization: "Bearer test" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_INPUT",
      request_id: expect.any(String),
    });
  });

  it("管理员权限不足返回 403", async () => {
    const { app, dependencies } = setup();
    dependencies.auth.loadContext.mockResolvedValue({ ...context, roles: [] });
    const response = await app.inject({
      url: "/admin/users",
      headers: { authorization: "Bearer test" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "UNAUTHORIZED", request_id: expect.any(String) });
  });

  it("创建用户的未知故障返回内部错误", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { authorization: "Bearer test" },
      payload: { username: "a", display_name: "A", password: "12345678" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe("INTERNAL_ERROR");
  });

  it("JSON 语法错误仍按请求输入处理", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_INPUT",
      request_id: expect.any(String),
    });
  });

  it.each([
    "/missing",
    "/conversations/missing",
    "/admin/users/missing",
    "/catalog/datasets/source/missing",
  ])("资源不存在 %s 返回带请求 ID 的 404", async (url) => {
    const { app } = setup();
    const response = await app.inject({ url, headers: { authorization: "Bearer test" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "NOT_FOUND", request_id: expect.any(String) });
  });
});
