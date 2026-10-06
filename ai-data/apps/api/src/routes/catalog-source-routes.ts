import { sourceListInputSchema, sourceListSchema } from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { AuthorizedSourceService } from "../catalog/authorized-source-service";
import { bearerToken } from "./auth-routes";

/** 业务源选项与管理诊断独立，始终基于请求的登录身份读取。 */
function registerCatalogSourceRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext">,
  service: Pick<AuthorizedSourceService, "list">,
): void {
  app.get("/catalog/sources", async (request, reply) => {
    const context = await auth.loadContext(bearerToken(request));
    const input = sourceListInputSchema.parse(request.query);
    return reply
      .header("cache-control", "no-store")
      .send(sourceListSchema.parse(await service.list(context, input)));
  });
}
export { registerCatalogSourceRoutes };
