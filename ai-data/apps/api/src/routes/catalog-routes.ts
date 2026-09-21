import { apiDatasetConfigSchema } from "@ai-data/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error";
import type { ApiAuthService, ApiCatalogService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import type { CatalogPermissionRepository } from "../catalog/catalog-types";
import {
  requireCatalogAdmin,
  type CatalogAdminService,
} from "../catalog-admin/catalog-admin-service";
import {
  columnPermissionInputSchema,
  objectPermissionInputSchema,
  rowPolicyInputSchema,
} from "../catalog-admin/catalog-admin-schemas";
import { bearerToken } from "./auth-routes";

/** 目录路径参数，只接受目标数据源标识。 */
const sourceParamsSchema = z.object({ sourceId: z.string().min(1) }).strict();
/** 目录详情在数据源参数上增加对象标识，仍拒绝未知字段。 */
const datasetParamsSchema = sourceParamsSchema.extend({ objectId: z.string().min(1) }).strict();
/** 旧完整配置增加并发版本；首次创建可以用 0，省略时由服务捕获当前基线。 */
const configInputSchema = apiDatasetConfigSchema.safeExtend({
  expected_version: z.number().int().nonnegative().optional(),
});
/** 搜索参数拒绝未知字段；limit 从 URL 文本转整数，默认 20，最多返回 100 项。 */
const searchQuerySchema = z
  .object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

/** 从 Access JWT 加载 API 可用于授权目录的身份上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: ApiAuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 注册面向当前用户的业务目录读取和管理员目录配置接口。 */
function registerCatalogRoutes(
  app: FastifyInstance,
  authService: ApiAuthService,
  catalogService: ApiCatalogService,
  permissionRepository: CatalogPermissionRepository,
  /** 生产装配必需；单模块路由测试可直接使用基础权限仓储。 */
  adminService?: Pick<
    CatalogAdminService,
    "saveObjectPermission" | "saveColumnPermission" | "saveRowPolicy"
  >,
): void {
  app.get("/catalog/datasets/:sourceId", async (request, reply) => {
    const { sourceId } = sourceParamsSchema.parse(request.params);
    const items = await catalogService.listAuthorized(
      await currentContext(request, authService),
      sourceId,
    );
    return reply.send({ items: items.map((item) => item.dataset) });
  });
  app.get("/catalog/datasets/:sourceId/search", async (request, reply) => {
    const { sourceId } = sourceParamsSchema.parse(request.params);
    const query = searchQuerySchema.parse(request.query);
    const items = await catalogService.searchAuthorized(
      await currentContext(request, authService),
      sourceId,
      query.query,
      query.limit,
    );
    return reply.send({ items: items.map((item) => item.dataset) });
  });
  app.get("/catalog/datasets/:sourceId/:objectId", async (request, reply) => {
    const { sourceId, objectId } = datasetParamsSchema.parse(request.params);
    const detail = await catalogService.getAuthorized(
      await currentContext(request, authService),
      sourceId,
      objectId,
    );
    if (!detail) throw new ApplicationError("NOT_FOUND", "数据集不存在或无权限访问");
    return reply.send(detail.dataset);
  });
  /** 返回画布和业务目录需要的批准关联关系及字段策略配置。 */
  app.get("/catalog/datasets/:sourceId/:objectId/business-config", async (request, reply) => {
    const { sourceId, objectId } = datasetParamsSchema.parse(request.params);
    const context = await currentContext(request, authService);
    const version = await catalogService.getConfigVersion(sourceId, objectId);
    const config = await catalogService.getAuthorizedConfig(context, sourceId, objectId);
    if (!config) throw new ApplicationError("NOT_FOUND", "数据集配置不存在或无权限访问");
    if (version !== (await catalogService.getConfigVersion(sourceId, objectId)))
      throw new ApplicationError("CONFLICT", "目录配置正在更新，请重新读取");
    reply.header("x-config-version", version);
    return reply.send(config);
  });
  app.put("/admin/catalog/datasets", async (request, reply) => {
    requireCatalogAdmin(await currentContext(request, authService));
    const { expected_version, ...config } = configInputSchema.parse(request.body);
    const version =
      expected_version ??
      (await catalogService.getConfigVersion(config.source_id, config.object_id));
    await catalogService.saveConfig(config, version);
    reply.header("x-config-version", version + 1);
    return reply.code(204).send();
  });
  app.put("/admin/catalog/object-permissions", async (request, reply) => {
    const context = await currentContext(request, authService);
    requireCatalogAdmin(context);
    const { source_id, expected_version, ...input } = objectPermissionInputSchema.parse(
      request.body,
    );
    if (adminService) {
      const saved = await adminService.saveObjectPermission(
        context,
        source_id,
        input,
        expected_version,
      );
      reply.header("x-policy-version", saved.version);
    } else await permissionRepository.saveObjectPermission(source_id, input);
    return reply.code(204).send();
  });
  app.put("/admin/catalog/column-permissions", async (request, reply) => {
    const context = await currentContext(request, authService);
    requireCatalogAdmin(context);
    const { source_id, expected_version, ...input } = columnPermissionInputSchema.parse(
      request.body,
    );
    if (adminService) {
      const saved = await adminService.saveColumnPermission(
        context,
        source_id,
        input,
        expected_version,
      );
      reply.header("x-policy-version", saved.version);
    } else await permissionRepository.saveColumnPermission(source_id, input);
    return reply.code(204).send();
  });
  app.put("/admin/catalog/row-policies", async (request, reply) => {
    const context = await currentContext(request, authService);
    requireCatalogAdmin(context);
    const { source_id, expected_version, ...input } = rowPolicyInputSchema.parse(request.body);
    if (adminService) {
      const saved = await adminService.saveRowPolicy(context, source_id, input, expected_version);
      reply.header("x-policy-version", saved.version);
    } else await permissionRepository.saveRowPolicy(source_id, input);
    return reply.code(204).send();
  });
}

export { registerCatalogRoutes };
