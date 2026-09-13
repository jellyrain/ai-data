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
import type { InternalServiceVerifier } from "./auth/internal-service-verifier";
import type { QueryAuditWriter } from "./query-execution/audited-query-service";

/** 组装 DAS 的路由与依赖；同时提供执行服务和验签器时才注册查询接口。 */
function createApp(
  config: DasConfig,
  metadataDatabase: MetadataDatabaseHealthChecker,
  catalogReader: CatalogReader,
  managementService: DataSourceManagementApi,
  queryExecution?: QueryExecutionService,
  queryVerifier?: InternalQueryVerifier,
  serviceVerifier?: Pick<InternalServiceVerifier, "verify">,
  queryAudit?: QueryAuditWriter,
): FastifyInstance {
  if (
    (queryExecution || queryVerifier || queryAudit) &&
    !(queryExecution && queryVerifier && queryAudit)
  ) {
    throw new Error("查询接口需要完整的执行、验签和审计依赖");
  }
  const app = Fastify({
    genReqId: () => crypto.randomUUID(),
    logger: {
      level: "info",
      redact: ["req.headers.authorization"],
      base: {
        service_id: config.service.service_id,
        service_version: config.service.service_version,
      },
    },
  });

  registerContractErrorHandler(app);
  registerHealthRoute(app, config, metadataDatabase);
  registerCatalogRoute(app, catalogReader, serviceVerifier);
  registerDataSourceManagementRoutes(app, managementService, serviceVerifier);
  if (queryExecution && queryVerifier && queryAudit)
    registerQueryRoute(app, queryExecution, queryVerifier, queryAudit);
  return app;
}

export { createApp };
