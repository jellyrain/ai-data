import type { FastifyInstance } from "fastify";
import { queryResultSchema, stableStringify } from "@ai-data/contracts";

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
      const current = await authorization.authorize(
        request.body,
        await authService.refreshContext(context),
        authorized.request.access.analysis_run_id,
      );
      if (
        stableStringify(current.request.query) !== stableStringify(authorized.request.query) ||
        stableStringify(current.request.access.output_masks) !==
          stableStringify(authorized.request.access.output_masks)
      )
        throw new ApplicationError("POLICY_REJECTED", "查询期间数据权限已变化，请重新查询");
      if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "数据查询已取消");
      return reply.header("cache-control", "no-store").send(
        queryResultSchema.parse({
          ...result,
          delivery: result.truncated
            ? { status: "truncated", total_row_count: null }
            : { status: "complete", total_row_count: result.row_count },
        }),
      );
    } finally {
      request.raw.removeListener("aborted", disconnect);
      reply.raw.removeListener("close", disconnect);
    }
  });
}

export { registerQueryRoutes };
