import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataAccessQueryRequestSchema, type QueryResult } from "@ai-data/contracts";
import { registerQueryRoutes } from "../../src/routes/query-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { ApplicationError } from "../../src/errors/application-error";
import { createApiDependencies } from "../support/api-fixtures";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** 路由真实执行身份复核和响应合同，替身仅提供授权结果及已脱敏的 DAS 表格。 */
function setup(count = 0, truncated = false) {
  const app = Fastify();
  apps.push(app);
  const dependencies = createApiDependencies();
  const request = dataAccessQueryRequestSchema.parse({
    access: {
      user_id: "user",
      organization_id: "org",
      analysis_run_id: "r",
      policy_version: 1,
      expires_at: "2026-09-14 08:00:00",
    },
    query: {
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visits", alias: "v" },
      select: [{ field: "v.id" }],
      limit: 50000,
    },
    signature: "test-signature",
  });
  const authorize = vi.fn(async () => ({ request, token: "internal" }));
  const result: QueryResult = {
    columns: [{ name: "id", data_type: "integer" }],
    rows: Array.from({ length: count }, (_, index) => ({ id: index + 1 })),
    row_count: count,
    truncated,
  };
  const execute = vi.fn(async () => result);
  registerContractErrorHandler(app);
  registerQueryRoutes(app, dependencies.auth, { authorize }, { execute });
  return {
    app,
    auth: dependencies.auth,
    authorize,
    execute,
    request,
    send: () =>
      app.inject({
        method: "POST",
        url: "/query",
        headers: { authorization: "Bearer browser-token" },
        payload: request.query,
      }),
  };
}

describe("浏览器完整明细交付", () => {
  it("一次查询返回五万行及准确总数，响应禁止共享缓存", async () => {
    const h = setup(50000);
    const response = await h.send();
    expect(response.statusCode).toBe(200);
    expect(response.json().rows).toHaveLength(50000);
    expect(response.json().delivery).toEqual({ status: "complete", total_row_count: 50000 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.auth.refreshContext).toHaveBeenCalledTimes(1);
  });
  it.each([
    [0, false, 0],
    [50, true, null],
  ] as const)("空结果或截断结果的总数正确 %#", async (rows, truncated, total) => {
    const response = await setup(rows, truncated).send();
    expect(response.statusCode).toBe(200);
    expect(response.json().delivery).toEqual({
      status: truncated ? "truncated" : "complete",
      total_row_count: total,
    });
  });
  it("查询结束时会话撤销则拒绝交付已取得的行", async () => {
    const h = setup(1);
    h.auth.refreshContext.mockRejectedValue(
      new ApplicationError("AUTHENTICATION_FAILED", "登录会话无效"),
    );
    const response = await h.send();
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty("rows");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("授权查询在执行期间变化时拒绝返回旧范围结果", async () => {
    const h = setup(1);
    h.authorize
      .mockResolvedValueOnce({ request: h.request, token: "internal" })
      .mockResolvedValueOnce({
        request: { ...h.request, query: { ...h.request.query, limit: 1 } },
        token: "new-token",
      });
    const response = await h.send();
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("POLICY_REJECTED");
    expect(response.json()).not.toHaveProperty("rows");
  });
});
