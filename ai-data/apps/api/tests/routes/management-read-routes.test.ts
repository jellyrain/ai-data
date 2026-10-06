import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/app";
import { createApiDependencies, context } from "../support/api-fixtures";
describe("管理读取使用当前权限和组织", () => {
  it.each(["GET", "PUT"] as const)("SQL Server 参数 %s 复核当前管理权限", async (method) => {
    const dependencies = createApiDependencies();
    dependencies.auth.refreshContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      const url = "/admin/data-access/services/das/data-source-secrets/ref/sqlserver-transport";
      const payload =
        method === "PUT"
          ? {
              expected_revision: "0".repeat(64),
              sqlserver_transport: { encrypt: true, trust_server_certificate: true },
            }
          : undefined;
      expect((await app.inject({ method, url, payload })).statusCode).toBe(401);
      const result = await app.inject({
        method,
        url,
        payload,
        headers: { authorization: "Bearer token" },
      });
      expect(result.statusCode).toBe(403);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(dependencies.dataAccess.managementClient.sqlServerTransport).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each([
    "/admin/users/assignment-options",
    "/admin/users/u/authorization",
    "/admin/catalog/role-options",
    "/admin/catalog/sources",
    "/admin/data-access/services",
  ])("旧管理员访问 %s 时按撤回后的身份拒绝", async (url) => {
    const dependencies = createApiDependencies();
    dependencies.auth.loadContext.mockResolvedValue(context);
    dependencies.auth.refreshContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      const result = await app.inject({ url, headers: { authorization: "Bearer token" } });
      expect(result.statusCode).toBe(403);
      expect(result.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
  it("目录角色选项不要求用户管理权限，组织取自当前身份", async () => {
    const dependencies = createApiDependencies();
    dependencies.auth.loadContext.mockResolvedValue({
      ...context,
      roles: [],
      permissions: ["catalog:manage"],
    });
    const roles = vi.fn(async () => []);
    dependencies.userAdmin.roles = roles;
    const app = await createApp(dependencies);
    app.log.level = "silent";
    try {
      const result = await app.inject({
        url: "/admin/catalog/role-options",
        headers: { authorization: "Bearer token" },
      });
      expect(result.statusCode).toBe(200);
      expect(roles).toHaveBeenCalledWith(context.organizationId);
      expect(
        (
          await app.inject({
            url: "/admin/catalog/role-options?organization_id=other",
            headers: { authorization: "Bearer token" },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
