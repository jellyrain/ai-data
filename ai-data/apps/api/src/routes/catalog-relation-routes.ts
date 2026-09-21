import { relationPublishInputSchema } from "@ai-data/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiAuthService } from "../app-types";
import type { CatalogRelationService } from "../catalog/catalog-relation-service";
import { bearerToken } from "./auth-routes";

/** 关系接口按数据源定位；管理与普通入口均不接受客户端组织上下文。 */
const sourceParamsSchema = z.object({ sourceId: z.string().min(1).max(128) }).strict();
/** 图中心对象只允许目录标识符，关系方向由已发布定义确定。 */
const graphParamsSchema = sourceParamsSchema
  .extend({ objectId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/) })
  .strict();

/** 管理发布和用户图读取共享关系服务，用户图不包含隐藏对象或连接字段。 */
function registerCatalogRelationRoutes(
  app: FastifyInstance,
  auth: Pick<ApiAuthService, "loadContext">,
  service: Pick<CatalogRelationService, "graph" | "publish">,
): void {
  for (const [path, admin] of [
    ["/admin/catalog/:sourceId/objects/:objectId/relations", true],
    ["/catalog/:sourceId/objects/:objectId/relations", false],
  ] as const) {
    app.get(path, async (request, reply) => {
      const context = await auth.loadContext(bearerToken(request));
      const { sourceId, objectId } = graphParamsSchema.parse(request.params);
      return reply.send(await service.graph(context, sourceId, objectId, admin));
    });
  }
  app.post("/admin/catalog/:sourceId/relations/publish", async (request, reply) => {
    const context = await auth.loadContext(bearerToken(request));
    const { sourceId } = sourceParamsSchema.parse(request.params);
    return reply.send({
      items: await service.publish(
        context,
        sourceId,
        relationPublishInputSchema.parse(request.body),
      ),
    });
  });
}

export { registerCatalogRelationRoutes };
