import type { MetadataQueryExecutor, MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { ApiConfig } from "../config/api-config";
import type { AuthContext } from "../auth/auth-types";
import type { JwtService } from "../auth/jwt-service";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { DataAccessCatalogClient } from "../data-access/data-access-types";
import type { ApiQueryAuthorization } from "../app-types";
import { BusinessCatalogService } from "../catalog/business-catalog-service";
import { RegisteredDataAccessCatalog } from "../catalog/registered-data-access-catalog";
import { SqlCatalogRepository } from "../catalog/sql-catalog-repository";
import { SqlDataAccessServiceRegistry } from "../data-access/sql-data-access-service-registry";
import type { DataAccessSessionService } from "../data-access/data-access-session-service";
import { QueryAuthorizationService } from "../query/query-authorization-service";
import { MetricService } from "../metrics/metric-service";
import { SqlMetricRepository } from "../metrics/sql-metric-repository";
import { PreferenceService } from "../preferences/preference-service";
import { SqlPreferenceRepository } from "../preferences/sql-preference-repository";
import { KnowledgeService } from "../knowledge/knowledge-service";
import { SqlKnowledgeRepository } from "../knowledge/sql-knowledge-repository";
import { MemoryAccess } from "./memory-access";
import { MemoryRuntime } from "./memory-runtime";
import { SqlMemoryEventRepository } from "./sql-memory-event-repository";
import { MemoryDispatcher } from "./memory-dispatcher";
import { memoryTaskConfigSchema } from "../config/memory-task-config";
import { serialExecutor } from "./serial-executor";
import type { KnowledgeDependencies } from "../knowledge/knowledge-types";

/** 所有事务内的记忆授权沿用同一 SQL executor，避免池容量为 1 时另借连接。 */
function createMemoryServices(dependencies: {
  database: MetadataTransactionalExecutor;
  config: ApiConfig;
  jwt: JwtService;
  catalogClient: DataAccessCatalogClient;
  dataAccessSessions: Pick<DataAccessSessionService, "listHealthyServices">;
  queryAuthorization: ApiQueryAuthorization;
  runs: AnalysisRunService;
  refreshContext(context: AuthContext): Promise<AuthContext>;
  isForegroundBusy(): boolean;
  onError(error: unknown): void;
  templates?: KnowledgeDependencies["templates"];
}) {
  const catalog = (executor: MetadataQueryExecutor) => {
    if (executor !== dependencies.database) executor = serialExecutor(executor);
    const repository = new SqlCatalogRepository(executor);
    const transactionRegistry = new SqlDataAccessServiceRegistry(executor);
    // SQL 读取沿用事务连接，注册会话使用启动时创建的服务，二者共同决定可用实例。
    const registry = {
      listHealthyServices: () =>
        dependencies.dataAccessSessions.listHealthyServices(transactionRegistry),
    };
    return new BusinessCatalogService(
      new RegisteredDataAccessCatalog(registry, dependencies.catalogClient),
      repository,
      repository,
    );
  };
  const authorization = (executor: MetadataQueryExecutor) =>
    new QueryAuthorizationService(catalog(executor), dependencies.jwt);
  const access = new MemoryAccess({ database: dependencies.database, catalog, authorization });
  const preferences = new PreferenceService({
    repository: new SqlPreferenceRepository(dependencies.database),
    authorize: (context, input, executor) => access.preference(context, input, executor),
    validateSource: (context, source, executor) => access.source(context, source, executor),
  });
  const metrics = new MetricService(
    new SqlMetricRepository(dependencies.database),
    dependencies.queryAuthorization,
    dependencies.runs,
    {
      authorizeScope: (context, scope, executor) => access.scope(context, scope, executor),
      authorizationForExecutor: authorization,
    },
  );
  const knowledge = new KnowledgeService({
    templates: dependencies.templates,
    repository: new SqlKnowledgeRepository(dependencies.database),
    metrics,
    authorizeScope: (context, scope, executor) => access.scope(context, scope, executor),
    validateSource: (context, source, executor, sharedReference) =>
      access.source(context, source, executor, sharedReference),
  });
  const runtime = new MemoryRuntime({ preferences, knowledge, access, runs: dependencies.runs });
  const events = new SqlMemoryEventRepository(dependencies.database);
  const config = memoryTaskConfigSchema.parse(dependencies.config.memory_tasks ?? {});
  const worker = config.enabled
    ? new MemoryDispatcher({
        repository: events,
        process: (context, event, executor) => runtime.process(context, event, executor),
        refreshContext: dependencies.refreshContext,
        isForegroundBusy: dependencies.isForegroundBusy,
        onError: dependencies.onError,
        concurrency: config.concurrency,
        pollMs: config.poll_ms,
        leaseMs: config.lease_ms,
        timeoutMs: config.timeout_ms,
        maxAttempts: config.max_attempts,
      })
    : undefined;
  const metricsForExecutor = (executor: MetadataQueryExecutor) =>
    new MetricService(
      new SqlMetricRepository(executor),
      authorization(executor),
      dependencies.runs,
      {
        authorizeScope: (context, scope) => access.scope(context, scope, executor),
        authorizationForExecutor: authorization,
      },
    );
  return {
    preferences,
    knowledge,
    metrics,
    runtime,
    events,
    worker,
    access,
    catalogForExecutor: catalog,
    authorizationForExecutor: authorization,
    metricsForExecutor,
  };
}

export { createMemoryServices };
