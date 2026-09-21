import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerCatalogRelationRoutes } from "../../src/routes/catalog-relation-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { context } from "../support/api-fixtures";

describe("批准关系 HTTP 入口", () => {
  it("图查询传递当前身份与明确的管理模式，发布严格校验后传递预期版本", async () => {
    const app = Fastify();
    registerContractErrorHandler(app);
    const service = {
      graph: vi.fn(async () => ({
        source_id: "source",
        object_id: "a",
        incoming: [],
        outgoing: [],
      })),
      publish: vi.fn(async () => []),
    };
    registerCatalogRelationRoutes(app, { loadContext: async () => context }, service);
    const headers = { authorization: "Bearer token" };
    expect(
      (await app.inject({ url: "/admin/catalog/source/objects/a/relations", headers })).statusCode,
    ).toBe(200);
    expect(service.graph).toHaveBeenLastCalledWith(context, "source", "a", true);
    expect(
      (await app.inject({ url: "/catalog/source/objects/a/relations", headers })).statusCode,
    ).toBe(200);
    expect(service.graph).toHaveBeenLastCalledWith(context, "source", "a", false);
    const payload = {
      changes: [{ action: "disable", object_id: "a", relation_id: "edge", expected_version: 1 }],
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/catalog/source/relations/publish",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(service.publish).toHaveBeenCalledWith(context, "source", payload);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/admin/catalog/source/relations/publish",
          headers,
          payload: { ...payload, organization_id: "foreign" },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});
