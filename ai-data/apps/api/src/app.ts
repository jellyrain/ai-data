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
import { registerAnalysisRoutes } from "./routes/analysis-routes";
import { registerMetricReportRoutes } from "./routes/metric-report-routes";
import { registerCatalogAdminRoutes } from "./routes/catalog-admin-routes";
import { bearerToken } from "./routes/auth-routes";
import { z } from "zod";
import { registerAgentRoutes } from "./routes/agent-routes";
import { registerModelResourceRoutes } from "./routes/model-resource-routes";
import { registerPreferenceRoutes } from "./routes/preference-routes";
import { registerKnowledgeRoutes } from "./routes/knowledge-routes";
import { registerMemoryEventRoutes } from "./routes/memory-event-routes";
import { registerReportManagementRoutes } from "./routes/report-management-routes";
import { registerReportExecutionRoutes } from "./routes/report-execution-routes";
import { registerCatalogRelationRoutes } from "./routes/catalog-relation-routes";
import { registerCatalogSourceRoutes } from "./routes/catalog-source-routes";
import { AuthorizedSourceService } from "./catalog/authorized-source-service";
import { registerUserAssignmentRoutes } from "./routes/user-assignment-routes";
import { registerCatalogManagementRoutes } from "./routes/catalog-management-routes";

/** 在分配应用资源前定位运行时缺失项，补充 TypeScript 无法覆盖的 JavaScript 调用入口。 */
function validateDependencies(dependencies: ApiDependencies): void {
  const required = {
    config: dependencies.config,
    metadataDatabase: dependencies.metadataDatabase,
    auth: dependencies.auth,
    userAdmin: dependencies.userAdmin,
    conversations: dependencies.conversations,
    "agentConfiguration.agents": dependencies.agentConfiguration?.agents,
    "agentConfiguration.models": dependencies.agentConfiguration?.models,
    "agentConfiguration.skills": dependencies.agentConfiguration?.skills,
    "analysis.runs": dependencies.analysis?.runs,
    "analysis.metrics": dependencies.analysis?.metrics,
    "analysis.reports": dependencies.analysis?.reports,
    "memory.preferences": dependencies.memory?.preferences,
    "memory.knowledge": dependencies.memory?.knowledge,
    "memory.events": dependencies.memory?.events,
    "reporting.definitions": dependencies.reporting?.definitions,
    "reporting.management": dependencies.reporting?.management,
    "reporting.executions": dependencies.reporting?.executions,
    "reporting.revisions": dependencies.reporting?.revisions,
    "catalog.relations": dependencies.catalog?.relations,
    "dataAccess.registry": dependencies.dataAccess?.registry,
    "dataAccess.catalogClient": dependencies.dataAccess?.catalogClient,
    "dataAccess.managementClient": dependencies.dataAccess?.managementClient,
    "catalog.service": dependencies.catalog?.service,
    "catalog.permissions": dependencies.catalog?.permissions,
    "catalog.admin": dependencies.catalog?.admin,
    "query.authorization": dependencies.query?.authorization,
    "query.client": dependencies.query?.client,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value == null) throw new Error(`API 缺少必需依赖: ${name}`);
  }
  if (dependencies.config.analysis_runtime?.enabled && !dependencies.runtime)
    throw new Error("API 缺少必需依赖: runtime");
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
  registerUserAssignmentRoutes(app, auth, dependencies.userAdmin);
  registerConversationRoutes(app, auth, conversations);
  registerAgentRoutes(app, auth, dependencies.agentConfiguration.agents);
  registerModelResourceRoutes(app, auth, dependencies.agentConfiguration);
  registerCatalogRoutes(app, auth, catalog.service, catalog.permissions, catalog.admin);
  registerCatalogSourceRoutes(
    app,
    auth,
    new AuthorizedSourceService({ registry: dataAccess.registry, catalog: catalog.service }),
  );
  registerCatalogAdminRoutes(app, auth, catalog.admin);
  registerCatalogManagementRoutes(app, auth, catalog, dataAccess.registry);
  registerCatalogRelationRoutes(app, auth, catalog.relations);
  registerReportManagementRoutes(app, auth, dependencies.reporting);
  registerReportExecutionRoutes(app, auth, dependencies.reporting);
  registerQueryRoutes(app, auth, query.authorization, query.client);
  registerAnalysisRoutes(app, auth, dependencies.analysis.runs, dependencies.runtime?.dispatcher);
  if (dependencies.runtime) {
    const runtime = dependencies.runtime;
    app.addHook("onReady", async () => runtime.start());
    app.addHook("onClose", async () => runtime.close());
    app.get("/analysis-runs/:id/tools", async (request, reply) => {
      const context = await auth.refreshContext(await auth.loadContext(bearerToken(request)));
      const { id } = z
        .object({ id: z.string().min(1).max(128) })
        .strict()
        .parse(request.params);
      await dependencies.analysis.runs.get(context, id);
      return reply
        .header("cache-control", "no-store")
        .send({ items: await runtime.repository.listAudits(context, id) });
    });
  }
  registerMetricReportRoutes(app, auth, dependencies.analysis, dependencies.memory.knowledge);
  registerPreferenceRoutes(app, auth, dependencies.memory.preferences);
  registerKnowledgeRoutes(app, auth, dependencies.memory.knowledge);
  registerMemoryEventRoutes(app, auth, dependencies.memory.events);
  if (dependencies.memory.worker) {
    const worker = dependencies.memory.worker;
    app.addHook("onReady", async () => worker.start());
    app.addHook("onClose", async () => worker.close());
  }
  return app;
}

export { createApp };
