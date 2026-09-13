import {
  apiDatasetConfigSchema,
  columnPermissionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "@ai-data/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApplicationError } from "../errors/application-error";
import type { ApiAuthService, ApiCatalogService } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import type { CatalogPermissionRepository } from "../catalog/catalog-types";
import { bearerToken } from "./auth-routes";

/** 目录路径参数，只接受目标数据源标识。 */
const sourceParamsSchema = z.object({ sourceId: z.string().min(1) }).strict();
/** 目录详情在数据源参数上增加对象标识，仍拒绝未知字段。 */
const datasetParamsSchema = sourceParamsSchema.extend({ objectId: z.string().min(1) }).strict();
/** 搜索参数拒绝未知字段；limit 从 URL 文本转整数，默认 20，最多返回 100 项。 */
const searchQuerySchema = z
  .object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();
/** 为共享对象权限合同补充所属数据源，未知字段处理继承权限合同。 */
const objectPermissionInputSchema = z
  .object({ source_id: z.string().min(1) })
  .merge(tablePermissionSchema);
/** 为共享字段权限合同补充所属数据源，列名与操作约束沿用共享合同。 */
const columnPermissionInputSchema = z
  .object({ source_id: z.string().min(1) })
  .merge(columnPermissionSchema);
/** 为共享行策略合同补充所属数据源，条件结构沿用共享合同。 */
const rowPolicyInputSchema = z.object({ source_id: z.string().min(1) }).merge(rowPolicySchema);

/** 从 Access JWT 加载 API 可用于授权目录的身份上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: ApiAuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 系统管理员或具有 catalog:manage 功能权限的身份可维护目录。 */
function requireCatalogAdmin(context: AuthContext): void {
  if (!context.roles.includes("system_admin") && !context.permissions.includes("catalog:manage"))
    throw new ApplicationError("UNAUTHORIZED", "无目录管理权限");
}

/** 注册面向当前用户的业务目录读取和管理员目录配置接口。 */
function registerCatalogRoutes(
  app: FastifyInstance,
  authService: ApiAuthService,
  catalogService: ApiCatalogService,
  permissionRepository: CatalogPermissionRepository,
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
    const config = await catalogService.getAuthorizedConfig(
      await currentContext(request, authService),
      sourceId,
      objectId,
    );
    if (!config) throw new ApplicationError("NOT_FOUND", "数据集配置不存在或无权限访问");
    return reply.send(config);
  });
  app.put("/admin/catalog/datasets", async (request, reply) => {
    requireCatalogAdmin(await currentContext(request, authService));
    await catalogService.saveConfig(apiDatasetConfigSchema.parse(request.body));
    return reply.code(204).send();
  });
  app.put("/admin/catalog/object-permissions", async (request, reply) => {
    requireCatalogAdmin(await currentContext(request, authService));
    const input = objectPermissionInputSchema.parse(request.body);
    await permissionRepository.saveObjectPermission(input.source_id, input);
    return reply.code(204).send();
  });
  app.put("/admin/catalog/column-permissions", async (request, reply) => {
    requireCatalogAdmin(await currentContext(request, authService));
    const input = columnPermissionInputSchema.parse(request.body);
    await permissionRepository.saveColumnPermission(input.source_id, input);
    return reply.code(204).send();
  });
  app.put("/admin/catalog/row-policies", async (request, reply) => {
    requireCatalogAdmin(await currentContext(request, authService));
    const input = rowPolicyInputSchema.parse(request.body);
    await permissionRepository.saveRowPolicy(input.source_id, input);
    return reply.code(204).send();
  });
}

export { registerCatalogRoutes };
