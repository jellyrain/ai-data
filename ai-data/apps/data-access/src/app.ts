import Fastify, { type FastifyInstance } from "fastify";

import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";

import type { CatalogReader } from "./catalog/catalog-service";
import type { DasConfig } from "./config/das-config";
import { registerCatalogRoute } from "./routes/catalog-route";
import {
  registerDataSourceManagementRoutes,
  type DataSourceManagementApi,
} from "./routes/data-source-management-route";
import { registerHealthRoute } from "./routes/health-route";
import { registerContractErrorHandler } from "./routes/contract-error";
import { registerQueryRoute } from "./routes/query-route";
import type { QueryExecutionService } from "./query-execution/query-execution-service";
import type { InternalQueryVerifier } from "./auth/internal-query-verifier";

/** 创建 DAS Fastify 应用；路由只允许通过显式注册加入内部服务。 */
function createApp(
  config: DasConfig,
  metadataDatabase: MetadataDatabaseHealthChecker,
  catalogReader: CatalogReader,
  managementService: DataSourceManagementApi,
  queryExecution?: QueryExecutionService,
  queryVerifier?: InternalQueryVerifier,
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: "info",
      base: {
        service_id: config.service.service_id,
        service_version: config.service.service_version,
      },
    },
  });

  registerContractErrorHandler(app);
  registerHealthRoute(app, config, metadataDatabase);
  registerCatalogRoute(app, catalogReader);
  registerDataSourceManagementRoutes(app, managementService);
  if (queryExecution && queryVerifier) registerQueryRoute(app, queryExecution, queryVerifier);
  return app;
}

export { createApp };
