import type { FastifyInstance } from "fastify";

import type { ApiAuthService, ApiQueryAuthorization, ApiQueryClient } from "../app-types";
import { bearerToken } from "./auth-routes";
import { ApplicationError } from "../errors/application-error";

/** 注册受本地用户权限保护的查询执行接口。 */
function registerQueryRoutes(
  app: FastifyInstance,
  authService: ApiAuthService,
  authorization: ApiQueryAuthorization,
  client: ApiQueryClient,
): void {
  app.post("/query", async (request, reply) => {
    const controller = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", disconnect);
    reply.raw.once("close", disconnect);
    try {
      const context = await authService.loadContext(bearerToken(request));
      if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "数据查询已取消");
      const authorized = await authorization.authorize(request.body, context);
      const result = await client.execute(authorized, { signal: controller.signal });
      if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "数据查询已取消");
      return reply.send(result);
    } finally {
      request.raw.removeListener("aborted", disconnect);
      reply.raw.removeListener("close", disconnect);
    }
  });
}

export { registerQueryRoutes };
