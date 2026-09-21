import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerMemoryEventRoutes } from "../../src/routes/memory-event-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { createApiDependencies, context } from "../support/api-fixtures";

describe("记忆任务管理接口", () => {
  it("管理身份按当前组织读取，未知查询归属或越界数量被拒绝", async () => {
    const app = Fastify();
    registerContractErrorHandler(app);
    const api = createApiDependencies();
    const events = { list: vi.fn(async () => []), retry: vi.fn(async () => {}) };
    registerMemoryEventRoutes(app, api.auth, events);
    try {
      expect(
        (
          await app.inject({
            url: "/admin/memory-events?limit=20",
            headers: { authorization: "Bearer test" },
          })
        ).statusCode,
      ).toBe(200);
      expect(events.list).toHaveBeenCalledWith(context, 20);
      expect(
        (
          await app.inject({
            url: "/admin/memory-events?organization_id=other",
            headers: { authorization: "Bearer test" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: "/admin/memory-events?limit=201",
            headers: { authorization: "Bearer test" },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("权限撤销后不能读取或重试后台任务", async () => {
    const app = Fastify();
    registerContractErrorHandler(app);
    const api = createApiDependencies();
    api.auth.refreshContext.mockResolvedValue({ ...context, roles: [], permissions: [] });
    const events = { list: vi.fn(async () => []), retry: vi.fn(async () => {}) };
    registerMemoryEventRoutes(app, api.auth, events);
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/admin/memory-events/event/retry",
            headers: { authorization: "Bearer test" },
          })
        ).statusCode,
      ).toBe(403);
      expect(events.retry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
