import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApiDependencies } from "./app-types";
import { ApplicationError } from "./errors/application-error";
import { registerAuthRoutes } from "./routes/auth-routes";
import { registerUserAdminRoutes } from "./routes/user-admin-routes";
import { registerConversationRoutes } from "./routes/conversation-routes";
import { registerContractErrorHandler } from "./routes/contract-error";
import { registerSystemRoutes } from "./routes/system-routes";
import { registerDataAccessRoutes } from "./routes/data-access-routes";
import { registerCatalogRoutes } from "./routes/catalog-routes";
import { registerQueryRoutes } from "./routes/query-routes";

/** 在分配应用资源前定位运行时缺失项，补充 TypeScript 无法覆盖的 JavaScript 调用入口。 */
function validateDependencies(dependencies: ApiDependencies): void {
  const required = {
    config: dependencies.config,
    metadataDatabase: dependencies.metadataDatabase,
    auth: dependencies.auth,
    conversations: dependencies.conversations,
    "dataAccess.registry": dependencies.dataAccess?.registry,
    "dataAccess.catalogClient": dependencies.dataAccess?.catalogClient,
    "dataAccess.managementClient": dependencies.dataAccess?.managementClient,
    "catalog.service": dependencies.catalog?.service,
    "catalog.permissions": dependencies.catalog?.permissions,
    "query.authorization": dependencies.query?.authorization,
    "query.client": dependencies.query?.client,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value == null) throw new Error(`API 缺少必需依赖: ${name}`);
  }
}

/** 使用完整具名依赖装配 API；所有当前启用的业务模块均在启动时注册。 */
async function createApp(dependencies: ApiDependencies): Promise<FastifyInstance> {
  validateDependencies(dependencies);
  const { config, metadataDatabase, auth, conversations, dataAccess, catalog, query } =
    dependencies;
  const app = Fastify({
    logger: {
      level: config.node_env === "production" ? "info" : "debug",
      redact: ["req.headers.authorization"],
      base: {
        service_id: config.service.service_id,
        service_version: config.service.service_version,
      },
    },
  });

  // 安全插件先注册，统一错误出口覆盖插件错误与随后注册的业务路由。
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => new ApplicationError("RATE_LIMITED", "请求过于频繁"),
  });
  registerContractErrorHandler(app);
  registerSystemRoutes(app, config, metadataDatabase);
  registerDataAccessRoutes(app, dataAccess, auth);
  registerAuthRoutes(app, auth, config.node_env === "production");
  registerUserAdminRoutes(app, auth);
  registerConversationRoutes(app, auth, conversations);
  registerCatalogRoutes(app, auth, catalog.service, catalog.permissions);
  registerQueryRoutes(app, auth, query.authorization, query.client);
  return app;
}

export { createApp };
