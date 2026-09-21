import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerModelResourceRoutes } from "../../src/routes/model-resource-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { context } from "../support/api-fixtures";

describe("模型和 Agent 资源接口", () => {
  it("提供已认证的模型版本与只读 Skill/工具目录，拒绝伪造组织参数", async () => {
    const app = Fastify();
    registerContractErrorHandler(app);
    const models = {
      publish: vi.fn(async () => ({ model_id: "demo", version: 1, has_api_key: true })),
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({ model_id: "demo", version: 1 })),
      setEnabled: vi.fn(async () => {}),
    };
    const skills = {
      list: vi.fn(() => [{ name: "query-dsl" }]),
      read: vi.fn(() => ({ content: "说明" })),
    };
    registerModelResourceRoutes(app, { loadContext: async () => context }, {
      models,
      skills,
    } as unknown as Parameters<typeof registerModelResourceRoutes>[2]);
    const headers = { authorization: "Bearer demo" };
    expect((await app.inject({ url: "/models" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/models", headers, payload: { model_id: "demo" } }))
        .statusCode,
    ).toBe(201);
    expect((await app.inject({ url: "/models/demo?version=1", headers })).json()).toMatchObject({
      version: 1,
    });
    expect(models.get).toHaveBeenCalledWith(context, "demo", 1);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/models/demo/status",
          headers,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: "/skills", headers })).json()).toEqual({
      items: [{ name: "query-dsl" }],
    });
    expect(
      (await app.inject({ url: "/skills/query-dsl?path=references/query.md", headers })).json(),
    ).toEqual({ content: "说明" });
    expect(skills.read).toHaveBeenCalledWith("query-dsl", "references/query.md");
    expect((await app.inject({ url: "/agent-tools", headers })).json().items).toContainEqual(
      expect.objectContaining({ name: "query_dataset" }),
    );
    for (const url of [
      "/models?organization_id=other",
      "/models/demo?version=0",
      "/skills?organization_id=other",
      "/agent-tools?x=1",
    ])
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    await app.close();
  });
});
