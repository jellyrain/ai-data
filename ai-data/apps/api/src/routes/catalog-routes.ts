import {
  apiDatasetConfigSchema,
  columnPermissionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "@ai-data/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthContext } from "../auth/auth-types";
import type { AuthService } from "../auth/auth-service";
import type { BusinessCatalogService } from "../catalog/business-catalog-service";
import type { CatalogPermissionRepository } from "../catalog/catalog-types";
import { bearerToken } from "./auth-routes";

/** 目录列表请求参数。 */
const sourceParamsSchema = z.object({ sourceId: z.string().min(1) }).strict();
/** 目录详情请求参数。 */
const datasetParamsSchema = sourceParamsSchema.extend({ objectId: z.string().min(1) }).strict();
/** 目录搜索查询参数。 */
const searchQuerySchema = z
  .object({ query: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();
/** 管理员对象权限请求。 */
const objectPermissionInputSchema = z
  .object({ source_id: z.string().min(1) })
  .merge(tablePermissionSchema);
/** 管理员字段权限请求。 */
const columnPermissionInputSchema = z
  .object({ source_id: z.string().min(1) })
  .merge(columnPermissionSchema);
/** 管理员行策略请求。 */
const rowPolicyInputSchema = z.object({ source_id: z.string().min(1) }).merge(rowPolicySchema);

/** 从 Access JWT 加载 API 可用于授权目录的身份上下文。 */
async function currentContext(
  request: FastifyRequest,
  authService: AuthService,
): Promise<AuthContext> {
  return authService.loadContext(bearerToken(request));
}

/** 限制业务目录维护接口只能由系统管理员使用。 */
function requireCatalogAdmin(context: AuthContext): void {
  if (!context.roles.includes("system_admin") && !context.permissions.includes("catalog:manage"))
    throw new Error("无目录管理权限");
}

/** 注册面向当前用户的业务目录读取和管理员目录配置接口。 */
function registerCatalogRoutes(
  app: FastifyInstance,
  authService: AuthService,
  catalogService: BusinessCatalogService,
  permissionRepository: CatalogPermissionRepository,
): void {
  app.get("/catalog/datasets/:sourceId", async (request, reply) => {
    try {
      const { sourceId } = sourceParamsSchema.parse(request.params);
      const items = await catalogService.listAuthorized(
        await currentContext(request, authService),
        sourceId,
      );
      return reply.send({ items: items.map((item) => item.dataset) });
    } catch (error) {
      return catalogReadError(reply, error);
    }
  });
  app.get("/catalog/datasets/:sourceId/search", async (request, reply) => {
    try {
      const { sourceId } = sourceParamsSchema.parse(request.params);
      const query = searchQuerySchema.parse(request.query);
      const items = await catalogService.searchAuthorized(
        await currentContext(request, authService),
        sourceId,
        query.query,
        query.limit,
      );
      return reply.send({ items: items.map((item) => item.dataset) });
    } catch (error) {
      return catalogReadError(reply, error);
    }
  });
  app.get("/catalog/datasets/:sourceId/:objectId", async (request, reply) => {
    try {
      const { sourceId, objectId } = datasetParamsSchema.parse(request.params);
      const detail = await catalogService.getAuthorized(
        await currentContext(request, authService),
        sourceId,
        objectId,
      );
      return detail
        ? reply.send(detail.dataset)
        : reply.code(404).send({ code: "NOT_FOUND", message: "数据集不存在或无权限访问" });
    } catch (error) {
      return catalogReadError(reply, error);
    }
  });
  /** 返回画布和业务目录需要的批准关联关系及字段策略配置。 */
  app.get("/catalog/datasets/:sourceId/:objectId/business-config", async (request, reply) => {
    try {
      const { sourceId, objectId } = datasetParamsSchema.parse(request.params);
      const config = await catalogService.getAuthorizedConfig(
        await currentContext(request, authService),
        sourceId,
        objectId,
      );
      return config
        ? reply.send(config)
        : reply.code(404).send({ code: "NOT_FOUND", message: "数据集配置不存在或无权限访问" });
    } catch (error) {
      return catalogReadError(reply, error);
    }
  });
  app.put("/admin/catalog/datasets", async (request, reply) => {
    try {
      requireCatalogAdmin(await currentContext(request, authService));
      await catalogService.saveConfig(apiDatasetConfigSchema.parse(request.body));
      return reply.code(204).send();
    } catch (error) {
      return catalogAdminError(reply, error);
    }
  });
  app.put("/admin/catalog/object-permissions", async (request, reply) => {
    try {
      requireCatalogAdmin(await currentContext(request, authService));
      const input = objectPermissionInputSchema.parse(request.body);
      await permissionRepository.saveObjectPermission(input.source_id, input);
      return reply.code(204).send();
    } catch (error) {
      return catalogAdminError(reply, error);
    }
  });
  app.put("/admin/catalog/column-permissions", async (request, reply) => {
    try {
      requireCatalogAdmin(await currentContext(request, authService));
      const input = columnPermissionInputSchema.parse(request.body);
      await permissionRepository.saveColumnPermission(input.source_id, input);
      return reply.code(204).send();
    } catch (error) {
      return catalogAdminError(reply, error);
    }
  });
  app.put("/admin/catalog/row-policies", async (request, reply) => {
    try {
      requireCatalogAdmin(await currentContext(request, authService));
      const input = rowPolicyInputSchema.parse(request.body);
      await permissionRepository.saveRowPolicy(input.source_id, input);
      return reply.code(204).send();
    } catch (error) {
      return catalogAdminError(reply, error);
    }
  });
}

/** 统一转换用户目录读取的认证、输入和 DAS 可用性错误。 */
function catalogReadError(
  reply: { code(statusCode: number): { send(body: unknown): unknown } },
  error: unknown,
) {
  if (error instanceof z.ZodError)
    return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "目录请求参数无效" });
  if (error instanceof Error && error.message === "没有可用的 DAS 数据源")
    return reply.code(503).send({ code: "DATA_ACCESS_UNAVAILABLE", message: error.message });
  return reply.code(401).send({ code: "UNAUTHENTICATED", message: "登录令牌无效" });
}

/** 统一转换管理员目录维护接口的认证和输入错误。 */
function catalogAdminError(
  reply: { code(statusCode: number): { send(body: unknown): unknown } },
  error: unknown,
) {
  if (error instanceof z.ZodError)
    return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "目录配置参数无效" });
  if (error instanceof Error && error.message === "无目录管理权限")
    return reply.code(403).send({ code: "FORBIDDEN", message: error.message });
  return reply.code(401).send({ code: "UNAUTHENTICATED", message: "登录令牌无效" });
}

export { registerCatalogRoutes };
