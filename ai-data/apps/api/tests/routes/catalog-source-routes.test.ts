import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCatalogSourceRoutes } from "../../src/routes/catalog-source-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { context } from "../support/api-fixtures";

describe("普通身份读取数据源HTTP入口", () => {
  it("检查登录、分页和未知字段，使用可信身份并禁止响应缓存", async () => {
    const app = Fastify();
    registerContractErrorHandler(app);
    const auth = { loadContext: vi.fn(async () => context) };
    const service = { list: vi.fn(async () => ({ items: [{ source_id: "demo" }] })) };
    registerCatalogSourceRoutes(app, auth, service);
    expect((await app.inject("/catalog/sources")).statusCode).toBe(401);
    const headers = { authorization: "Bearer token" };
    expect((await app.inject({ url: "/catalog/sources?limit=101", headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/catalog/sources?user_id=other", headers })).statusCode).toBe(
      400,
    );
    const response = await app.inject({ url: "/catalog/sources?limit=5", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ items: [{ source_id: "demo" }] });
    expect(service.list).toHaveBeenCalledWith(context, { limit: 5 });
    await app.close();
  });
});
