import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { context, createApiDependencies } from "../support/api-fixtures";
describe("API 数据库连接管理授权", () => {
  it.each([
    ["GET", "", "list"],
    ["POST", "", "create"],
    ["POST", "/test", "test-draft"],
    ["GET", "/reader", "get"],
    ["PUT", "/reader", "update"],
    ["POST", "/reader/delete", "remove"],
    ["POST", "/reader/test", "test"],
    ["GET", `/${encodeURIComponent("医院业务库")}`, "get"],
    ["PUT", `/${encodeURIComponent("医院业务库")}`, "update"],
    ["POST", `/${encodeURIComponent("医院业务库")}/delete`, "remove"],
    ["POST", `/${encodeURIComponent("医院业务库")}/test`, "test"],
  ] as const)("%s %s 逐次校验身份并路由到选定 DAS", async (method, suffix, operation) => {
    const dependencies = createApiDependencies();
    dependencies.dataAccess.registry.listHealthyServices.mockResolvedValue([
      { serviceId: "das-test", serviceUrl: "http://das.test:3102" },
    ] as never);
    const connection = vi.fn(async () => ({ items: [] }));
    dependencies.dataAccess.managementClient.connection = connection;
    const app = await createApp(dependencies);
    app.log.level = "silent";
    const url = `/admin/data-access/services/das-test/database-connections${suffix}`;
    try {
      expect(
        (await app.inject({ method, url, ...(method !== "GET" ? { payload: {} } : {}) }))
          .statusCode,
      ).toBe(401);
      dependencies.auth.loadContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
      const request = {
        method,
        url,
        headers: { authorization: "Bearer user" },
        ...(method !== "GET" ? { payload: {} } : {}),
      };
      expect((await app.inject(request)).statusCode).toBe(403);
      expect(connection).not.toHaveBeenCalled();
      dependencies.auth.loadContext.mockResolvedValue({
        ...context,
        roles: [],
        permissions: ["data-access:manage"],
      });
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(connection).toHaveBeenCalledWith(
        "das-test",
        "http://das.test:3102",
        operation,
        suffix && operation !== "test-draft"
          ? decodeURIComponent(suffix.split("/")[1]!)
          : undefined,
        method === "GET" ? undefined : {},
      );
    } finally {
      await app.close();
    }
  });
});
