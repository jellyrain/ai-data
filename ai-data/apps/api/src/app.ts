import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";

import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import type { ApiConfig } from "./config/api-config";
import type { AuthService } from "./auth/auth-service";
import type { ConversationService } from "./conversations/conversation-service";
import type {
  DataAccessCatalogClient,
  DataAccessServiceRegistry,
} from "./data-access/data-access-types";
import type { BusinessCatalogService } from "./catalog/business-catalog-service";
import type { CatalogPermissionRepository } from "./catalog/catalog-types";
import { registerAuthRoutes } from "./routes/auth-routes";
import { registerUserAdminRoutes } from "./routes/user-admin-routes";
import { registerConversationRoutes } from "./routes/conversation-routes";
import { registerContractErrorHandler } from "./routes/contract-error";
import { registerSystemRoutes } from "./routes/system-routes";
import { registerDataAccessRoutes } from "./routes/data-access-routes";
import { registerCatalogRoutes } from "./routes/catalog-routes";
import { registerQueryRoutes } from "./routes/query-routes";
import type { QueryAuthorizationService } from "./query/query-authorization-service";
import type { DataAccessQueryClient } from "./data-access/data-access-query-client";

/** 创建 API Fastify 应用；业务路由通过后续步骤显式注册。 */
async function createApp(
  config: ApiConfig,
  metadataDatabase: MetadataDatabaseHealthChecker,
  authService?: AuthService,
  conversationService?: ConversationService,
  dataAccessRegistry?: DataAccessServiceRegistry,
  dataAccessCatalogClient?: DataAccessCatalogClient,
  catalogService?: BusinessCatalogService,
  catalogPermissionRepository?: CatalogPermissionRepository,
  queryAuthorization?: QueryAuthorizationService,
  queryClient?: DataAccessQueryClient,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.node_env === "production" ? "info" : "debug",
      base: {
        service_id: config.service.service_id,
        service_version: config.service.service_version,
      },
    },
  });

  /** 基础安全能力必须先于业务路由注册。 */
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  /** 统一错误出口覆盖随后注册的全部 API 路由。 */
  registerContractErrorHandler(app);
  registerSystemRoutes(app, config, metadataDatabase);
  if (dataAccessRegistry && dataAccessCatalogClient)
    registerDataAccessRoutes(app, dataAccessRegistry, dataAccessCatalogClient);
  if (authService) {
    /** 认证、用户管理与会话路由仅在运行依赖完整时注册。 */
    registerAuthRoutes(app, authService, config.node_env === "production");
    registerUserAdminRoutes(app, authService);
    if (conversationService) registerConversationRoutes(app, authService, conversationService);
    if (catalogService && catalogPermissionRepository)
      registerCatalogRoutes(app, authService, catalogService, catalogPermissionRepository);
    if (queryAuthorization && queryClient)
      registerQueryRoutes(app, authService, queryAuthorization, queryClient);
  }
  return app;
}

export { createApp };
