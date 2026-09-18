import type { FastifyInstance } from "fastify";
import type { ApiAuthService } from "../app-types";
import type { CatalogAdminService } from "../catalog-admin/catalog-admin-service";
import {
  policyListQuerySchema,
  policyParamsSchema,
  policyVersionParamsSchema,
  queryPreviewInputSchema,
} from "../catalog-admin/catalog-admin-schemas";
import { ApplicationError } from "../errors/application-error";
import { bearerToken } from "./auth-routes";

/** 目录策略版本和预览接口从 Access JWT 获取当前管理员与组织。 */
function registerCatalogAdminRoutes(
  app: FastifyInstance,
  authService: Pick<ApiAuthService, "loadContext">,
  service: Pick<CatalogAdminService, "listVersions" | "getVersion" | "previewQuery">,
): void {
  app.get("/admin/catalog/policy-versions/:sourceId/:roleId", async (request, reply) => {
    const context = await authService.loadContext(bearerToken(request));
    const { sourceId, roleId } = policyParamsSchema.parse(request.params);
    const { limit, before_version } = policyListQuerySchema.parse(request.query);
    return reply.send({
      items: await service.listVersions(context, sourceId, roleId, limit, before_version),
    });
  });
  app.get("/admin/catalog/policy-versions/:sourceId/:roleId/current", async (request, reply) => {
    const context = await authService.loadContext(bearerToken(request));
    const { sourceId, roleId } = policyParamsSchema.parse(request.params);
    const version = await service.getVersion(context, sourceId, roleId);
    if (!version) throw new ApplicationError("NOT_FOUND", "当前角色尚无策略版本");
    return reply.send(version);
  });
  app.get("/admin/catalog/policy-versions/:sourceId/:roleId/:version", async (request, reply) => {
    const context = await authService.loadContext(bearerToken(request));
    const { sourceId, roleId, version } = policyVersionParamsSchema.parse(request.params);
    const saved = await service.getVersion(context, sourceId, roleId, version);
    if (!saved) throw new ApplicationError("NOT_FOUND", "策略版本不存在");
    return reply.send(saved);
  });
  app.post("/admin/catalog/query-preview", async (request, reply) => {
    const context = await authService.loadContext(bearerToken(request));
    const { role_id, query } = queryPreviewInputSchema.parse(request.body);
    return reply.send(await service.previewQuery(context, role_id, query));
  });
}

export { registerCatalogAdminRoutes };
