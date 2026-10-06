import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createApiDependencies } from "../support/api-fixtures";
import { registerKnowledgeRoutes } from "../../src/routes/knowledge-routes";
import { registerPreferenceRoutes } from "../../src/routes/preference-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { ApplicationError } from "../../src/errors/application-error";

describe("知识管理读取的当前身份与缓存边界", () => {
  it("新管理读取及偏好编辑状态刷新当前身份，禁止缓存并拒绝额外组织参数", async () => {
    const dependencies = createApiDependencies(),
      app = Fastify();
    registerContractErrorHandler(app);
    registerKnowledgeRoutes(app, dependencies.auth, dependencies.memory.knowledge);
    registerPreferenceRoutes(app, dependencies.auth, dependencies.memory.preferences);
    dependencies.memory.preferences.editState.mockResolvedValue({
      status: "deleted",
      version: 2,
    } as never);
    const headers = { authorization: "Bearer test" };
    try {
      for (const url of [
        "/admin/knowledge",
        "/admin/knowledge/owner-options",
        "/me/preferences/time/edit-state",
      ]) {
        const result = await app.inject({ url, headers });
        expect(result.statusCode).toBe(200);
        expect(result.headers["cache-control"]).toBe("no-store");
        expect(
          (await app.inject({ url: url + "?organization_id=other", headers })).statusCode,
        ).toBe(400);
      }
      expect(dependencies.auth.refreshContext).toHaveBeenCalled();
      dependencies.auth.refreshContext.mockRejectedValueOnce(
        new ApplicationError("UNAUTHORIZED", "账号停用"),
      );
      expect((await app.inject({ url: "/knowledge", headers })).statusCode).toBe(403);
      expect(dependencies.memory.knowledge.listPublished).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
