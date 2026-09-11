import type { FastifyInstance } from "fastify";
import type { AuthService } from "../auth/auth-service";
import type { QueryAuthorizationService } from "../query/query-authorization-service";
import type { DataAccessQueryClient } from "../data-access/data-access-query-client";
import { bearerToken } from "./auth-routes";

/** 注册受本地用户权限保护的查询执行接口。 */
function registerQueryRoutes(
  app: FastifyInstance,
  authService: AuthService,
  authorization: QueryAuthorizationService,
  client: DataAccessQueryClient,
): void {
  app.post("/query", async (request, reply) => {
    try {
      const context = await authService.loadContext(bearerToken(request));
      const authorized = await authorization.authorize(request.body, context);
      const result = await client.execute(authorized);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "查询失败";
      return reply.code(400).send({ code: "POLICY_REJECTED", message, request_id: request.id });
    }
  });
}

export { registerQueryRoutes };
