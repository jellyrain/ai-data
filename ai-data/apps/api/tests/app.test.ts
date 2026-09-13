import { describe, expect, expectTypeOf, it } from "vitest";
import { createApp } from "../src/app";
import type { ApiDependencies } from "../src/app-types";
import type { AuthServiceDependencies } from "../src/auth/auth-service";
import type { AuthRepository, UserAdminRepository } from "../src/auth/auth-types";
import { createApiDependencies } from "./support/api-fixtures";

describe("应用依赖装配", () => {
  it("完整具名依赖启用全部业务模块", async () => {
    expectTypeOf<Parameters<typeof createApp>[0]>().toEqualTypeOf<ApiDependencies>();
    expectTypeOf<Omit<ApiDependencies, "query">>().not.toExtend<ApiDependencies>();
    expectTypeOf<AuthRepository>().not.toExtend<AuthServiceDependencies["repository"]>();
    expectTypeOf<AuthServiceDependencies["repository"]>().toEqualTypeOf<UserAdminRepository>();
    const app = await createApp(createApiDependencies());
    try {
      for (const [method, url] of [
        ["GET", "/health"],
        ["GET", "/auth/me"],
        ["GET", "/conversations"],
        ["GET", "/catalog/datasets/:sourceId"],
        ["GET", "/admin/users"],
        ["GET", "/internal/data-access/services"],
        ["POST", "/query"],
      ] as const)
        expect(app.hasRoute({ method, url }), url).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("限流插件通过统一出口返回 429 并保留重试提示", async () => {
    const app = await createApp(createApiDependencies());
    app.log.level = "silent";
    try {
      for (let index = 0; index < 300; index++) {
        expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
      }
      const response = await app.inject({ url: "/health" });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({
        code: "RATE_LIMITED",
        request_id: expect.any(String),
      });
      expect(response.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it.each(["auth", "query.client", "catalog.permissions", "dataAccess.registry"])(
    "必需依赖 %s 缺失时在启动阶段给出名称",
    async (path) => {
      const dependencies = createApiDependencies();
      const parts = path.split(".");
      if (parts.length === 1) Reflect.deleteProperty(dependencies, parts[0]);
      else {
        const group = Reflect.get(dependencies, parts[0]);
        Reflect.deleteProperty(group, parts[1]);
      }
      await expect(createApp(dependencies)).rejects.toThrow(path);
    },
  );
});
