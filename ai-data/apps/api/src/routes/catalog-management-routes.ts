import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adminDatasetDetailSchema,
  datasetSchema,
  currentPolicyStateSchema,
} from "@ai-data/contracts";
import type { ApiAuthService, ApiDependencies } from "../app-types";
import { requireCatalogAdmin } from "../catalog-admin/catalog-admin-service";
import { bearerToken } from "./auth-routes";

/** 管理目录不依赖业务角色的可见对象，也不泄露 DAS 连接地址。 */
function registerCatalogManagementRoutes(
  app: FastifyInstance,
  auth: ApiAuthService,
  catalog: ApiDependencies["catalog"],
  registry: ApiDependencies["dataAccess"]["registry"],
): void {
  const empty = z.object({}).strict();
  const id = z.string().min(1).max(128);
  const source = z.object({ sourceId: id }).strict();
  const object = source
    .extend({
      objectId: z
        .string()
        .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.$]*$/u)
        .max(256),
    })
    .strict();
  app.get("/admin/catalog/sources", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    requireCatalogAdmin(context);
    empty.parse(request.query);
    const sources = (await registry.listHealthyServices()).flatMap((service) => service.sources);
    return {
      items: [
        ...new Map(
          sources.map((item) => [
            item.source_id,
            { source_id: item.source_id, status: item.status },
          ]),
        ).values(),
      ],
    };
  });
  app.get("/admin/catalog/datasets/:sourceId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    empty.parse(request.query);
    return {
      items: datasetSchema
        .array()
        .parse(await catalog.service.listManaged(context, source.parse(request.params).sourceId)),
    };
  });
  app.get("/admin/catalog/datasets/:sourceId/:objectId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    empty.parse(request.query);
    const { sourceId, objectId } = object.parse(request.params);
    return adminDatasetDetailSchema.parse(
      await catalog.service.managedDetail(context, sourceId, objectId),
    );
  });
  app.get("/admin/catalog/policies/:sourceId/:roleId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
    empty.parse(request.query);
    const { sourceId, roleId } = source.extend({ roleId: id }).strict().parse(request.params);
    return currentPolicyStateSchema.parse(
      await catalog.admin.currentState(context, sourceId, roleId),
    );
  });
}
export { registerCatalogManagementRoutes };
