import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { SqlMemoryEventRepository } from "../memory/sql-memory-event-repository";
import { ApplicationError } from "../errors/application-error";
import { bearerToken } from "./auth-routes";

/** 管理入口仅提供脱敏状态与失败重试，身份所属组织由服务器决定。 */
function registerMemoryEventRoutes(
  app: FastifyInstance,
  auth: ApiAuthService,
  events: Pick<SqlMemoryEventRepository, "list" | "retry">,
): void {
  const authorize = async (token: string) => {
    const context = await auth.refreshContext(await auth.loadContext(token));
    if (
      !context.roles.includes("system_admin") &&
      !context.permissions.includes("knowledge:manage")
    )
      throw new ApplicationError("UNAUTHORIZED", "无权管理记忆任务");
    return context;
  };
  app.get("/admin/memory-events", async (request, reply) => {
    const context = await authorize(bearerToken(request));
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .strict()
      .parse(request.query);
    return reply
      .header("cache-control", "no-store")
      .send({ items: await events.list(context, limit) });
  });
  app.post("/admin/memory-events/:id/retry", async (request, reply) => {
    const context = await authorize(bearerToken(request));
    const { id } = z
      .object({ id: z.string().min(1).max(128) })
      .strict()
      .parse(request.params);
    await events.retry(context, id);
    return reply.code(204).send();
  });
}

export { registerMemoryEventRoutes };
