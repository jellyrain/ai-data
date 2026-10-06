import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { ApplicationError } from "../../src/errors/application-error";
import { context, createApiDependencies } from "../support/api-fixtures";

const settings = {
  report_id: "report",
  basis: "definition",
  expected_version: 3,
  owner_user_id: "fresh-user",
  shared_with: [],
  members: [],
};

describe("报表分享与导出的当前身份边界", () => {
  it("作者分享读取和候选入口刷新身份、校验查询并禁止缓存", async () => {
    const dependencies = createApiDependencies();
    const fresh = { ...context, userId: "fresh-user" };
    dependencies.auth.refreshContext = vi.fn(async () => fresh);
    const get = vi.fn(async () => settings);
    const candidates = vi.fn(async () => ({ items: [] }));
    Object.assign(dependencies.reporting, { sharing: { get, candidates } });
    const app = await createApp(dependencies);
    try {
      expect((await app.inject("/reports/report/sharing")).statusCode).toBe(401);
      const headers = { authorization: "Bearer token" };
      const response = await app.inject({ url: "/reports/report/sharing", headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(settings);
      expect(get).toHaveBeenCalledExactlyOnceWith(fresh, "report");
      const candidateResponse = await app.inject({
        url: "/reports/report/share-candidates?search=%E7%A7%91&limit=20",
        headers,
      });
      expect(candidateResponse.statusCode).toBe(200);
      expect(candidateResponse.headers["cache-control"]).toBe("no-store");
      expect(candidates).toHaveBeenCalledWith(fresh, "report", { search: "科", limit: 20 });
      for (const url of [
        "/reports/report/sharing?user_id=other",
        "/reports/report/share-candidates?organization_id=other",
        "/reports/report/share-candidates?limit=101",
      ])
        expect((await app.inject({ url, headers })).statusCode).toBe(400);
      expect(get).toHaveBeenCalledTimes(1);
      expect(candidates).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    { method: "PUT" as const, url: "/reports/report/sharing", service: "share" as const },
    {
      method: "GET" as const,
      url: "/reports/report/export-content?version=2",
      service: "exportReport" as const,
    },
    {
      method: "GET" as const,
      url: "/conversations/conversation/export-content",
      service: "exportConversation" as const,
    },
  ])("$service 使用刷新身份且撤权后拒绝业务调用", async ({ method, url, service }) => {
    const dependencies = createApiDependencies();
    const fresh = { ...context, userId: "fresh-user" };
    const refresh = vi.fn(async () => fresh);
    dependencies.auth.refreshContext = refresh;
    const run = vi.fn(async (current: typeof context) => ({ user_id: current.userId }));
    Object.assign(dependencies.reporting.management, { [service]: run });
    const app = await createApp(dependencies);
    try {
      const request = {
        method,
        url,
        headers: { authorization: "Bearer token" },
        ...(method === "PUT" ? { payload: { expected_version: 3, shared_with: [] } } : {}),
      };
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(run.mock.calls[0]?.[0]).toEqual(fresh);
      if (method === "GET") expect(response.headers["cache-control"]).toBe("no-store");
      refresh.mockRejectedValueOnce(new ApplicationError("AUTHENTICATION_FAILED", "身份已撤回"));
      expect((await app.inject(request)).statusCode).toBe(401);
      expect(run).toHaveBeenCalledTimes(1);
      expect(dependencies.reporting.executions.execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
