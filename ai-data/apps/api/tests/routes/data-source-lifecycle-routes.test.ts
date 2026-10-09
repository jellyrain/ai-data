import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createApiDependencies, context } from "../support/api-fixtures";

describe("数据源生命周期路由", () => {
  it("删除逐次授权并经过协调服务，清理失败保持失败响应", async () => {
    const deps = createApiDependencies();
    deps.dataAccess.registry.listHealthyServices.mockResolvedValue([
      { serviceId: "das", serviceUrl: "http://das" },
    ] as never);
    const app = await createApp(deps);
    app.log.level = "silent";
    const request = {
      method: "POST" as const,
      url: "/admin/data-access/services/das/data-sources/delete",
      headers: { authorization: "Bearer user" },
      payload: {
        source_id: "危急值数据",
        expected_revision: "a".repeat(64),
        expected_objects_revision: "b".repeat(64),
      },
    };
    try {
      deps.auth.loadContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
      expect((await app.inject(request)).statusCode).toBe(403);
      expect(deps.dataAccess.sourceLifecycle.execute).not.toHaveBeenCalled();
      deps.auth.loadContext.mockResolvedValue({
        ...context,
        roles: [],
        permissions: ["data-access:manage"],
      });
      deps.dataAccess.sourceLifecycle.execute.mockRejectedValueOnce(new Error("清理失败"));
      expect((await app.inject(request)).statusCode).toBe(500);
      deps.dataAccess.sourceLifecycle.execute.mockResolvedValueOnce({ source_id: "危急值数据" });
      expect((await app.inject(request)).statusCode).toBe(200);
      expect(deps.dataAccess.managementClient.execute).not.toHaveBeenCalled();
      expect(deps.dataAccess.sourceLifecycle.execute).toHaveBeenLastCalledWith(
        "das",
        "http://das",
        "data-sources/delete",
        request.payload,
      );
    } finally {
      await app.close();
    }
  });
});
