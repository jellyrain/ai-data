import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";

import { createApp } from "./app";
import { AuthService } from "./auth/auth-service";
import { AuthContextCache } from "./auth/auth-context-cache";
import { loadApiConfig } from "./config/api-config";
import { JwtService } from "./auth/jwt-service";
import { SqlAuthRepository } from "./auth/sql-auth-repository";
import { hashPassword } from "./auth/password";
import { ConversationService } from "./conversations/conversation-service";
import { SqlConversationRepository } from "./conversations/sql-conversation-repository";
import { HttpDataAccessCatalogClient } from "./data-access/data-access-catalog-client";
import { SqlDataAccessServiceRegistry } from "./data-access/sql-data-access-service-registry";
import { BusinessCatalogService } from "./catalog/business-catalog-service";
import { RegisteredDataAccessCatalog } from "./catalog/registered-data-access-catalog";
import { SqlCatalogRepository } from "./catalog/sql-catalog-repository";
import { QueryAuthorizationService } from "./query/query-authorization-service";
import { DataAccessQueryClient } from "./data-access/data-access-query-client";
import { DataAccessSessionService } from "./data-access/data-access-session-service";
import { DataAccessManagementClient } from "./data-access/data-access-management-client";
import { AnalysisRunService } from "./analysis-runs/analysis-run-service";
import { SqlAnalysisRunRepository } from "./analysis-runs/sql-analysis-run-repository";
import { createReportServices } from "./reports/create-report-services";
import { CatalogRelationService } from "./catalog/catalog-relation-service";
import { SqlRelationRepository } from "./catalog/sql-relation-repository";
import { CatalogAdminService } from "./catalog-admin/catalog-admin-service";
import { SqlCatalogAdminRepository } from "./catalog-admin/sql-catalog-admin-repository";
import { createAnalysisRuntime } from "./runtime/create-analysis-runtime";
import { ApplicationError } from "./errors/application-error";
import { createAgentConfiguration } from "./agents/create-agent-configuration";
import { createMemoryServices } from "./memory/create-memory-services";

/** API 迁移随应用发布，独立于 TypeScript bundle。 */
const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
/** API 默认启动配置文件路径，可通过 API_CONFIG_PATH 指向部署配置。 */
const defaultConfigPath = fileURLToPath(new URL("../config/api.config.json", import.meta.url));
/** API JWT 密钥随实例保存在本地，不写入元数据库。 */
const defaultJwtKeyDirectory = fileURLToPath(new URL("../secrets", import.meta.url));

/** 读取部署配置、迁移 API 元数据库并装配服务；启动失败时释放数据库连接。 */
async function start(): Promise<void> {
  const config = loadApiConfig(process.env.API_CONFIG_PATH ?? defaultConfigPath);
  const metadataDatabase = await SqlServerMetadataDatabase.connect(config.metadata_sqlserver);
  let runtime: ReturnType<typeof createAnalysisRuntime> | undefined;
  let memory: ReturnType<typeof createMemoryServices> | undefined;
  let reporting: ReturnType<typeof createReportServices> | undefined;

  try {
    await metadataDatabase.initializeSchema(migrationsDirectory);
    const jwt = await JwtService.create(config, config.jwt.key_directory ?? defaultJwtKeyDirectory);
    const authRepository = new SqlAuthRepository(metadataDatabase);
    const conversationRepository = new SqlConversationRepository(metadataDatabase);
    const dataAccessRegistry = new DataAccessSessionService(
      new SqlDataAccessServiceRegistry(metadataDatabase),
      jwt,
      config.trusted_data_access_services ?? [],
    );
    const dataAccessCatalogClient = new HttpDataAccessCatalogClient(jwt);
    const catalogRepository = new SqlCatalogRepository(metadataDatabase);
    const rawCatalog = new RegisteredDataAccessCatalog(dataAccessRegistry, dataAccessCatalogClient);
    const businessCatalog = new BusinessCatalogService(
      rawCatalog,
      catalogRepository,
      catalogRepository,
    );
    const catalogAdminRepository = new SqlCatalogAdminRepository(metadataDatabase);
    const queryAuthorization = new QueryAuthorizationService(
      businessCatalog,
      jwt,
      async (context, sourceId) =>
        1 + (await catalogAdminRepository.currentPolicyVersion(context, sourceId)),
    );
    const authService = new AuthService({
      repository: authRepository,
      jwt,
      contextCache: new AuthContextCache(),
    });
    const queryClient = new DataAccessQueryClient(dataAccessRegistry);
    const runs = new AnalysisRunService({
      repository: new SqlAnalysisRunRepository(metadataDatabase),
      authorization: queryAuthorization,
      client: queryClient,
      refreshContext: (context) => authService.refreshContext(context),
      applyPreferenceAnswer: async (context, id, approved, key, executor) => {
        await memory!.preferences.confirm(context, id, approved, key, executor);
      },
      completeOperation: (context, runId, executor, content) =>
        reporting!.complete(context, runId, executor, content),
    });
    // 默认管理员初始化先于监听端口，确保首次启动的管理入口有可用账号。
    if (config.bootstrap_admin) {
      await authRepository.ensureBootstrapAdmin({
        userId: `bootstrap-${config.bootstrap_admin.organization_id}`,
        organizationId: config.bootstrap_admin.organization_id,
        organizationCode: config.bootstrap_admin.organization_code,
        organizationName: config.bootstrap_admin.organization_name,
        username: config.bootstrap_admin.username,
        displayName: config.bootstrap_admin.display_name,
        passwordHash: await hashPassword(config.bootstrap_admin.password),
      });
    }
    memory = createMemoryServices({
      templates: {
        validate: (context, content, executor) =>
          reporting!.templates.validate(context, content, executor),
        assertSubmit: (context, content, executor) =>
          reporting!.templates.assertSubmit(context, content, executor),
      },
      database: metadataDatabase,
      config,
      jwt,
      catalogClient: dataAccessCatalogClient,
      queryAuthorization,
      runs,
      refreshContext: (context) => authService.refreshContext(context),
      isForegroundBusy: () => runtime?.dispatcher.isBusy() ?? false,
      onError: (error) =>
        process.stderr.write(
          `记忆调度失败: ${error instanceof ApplicationError ? error.code : "INTERNAL_ERROR"}\n`,
        ),
    });
    const metrics = memory.metrics;
    const skillsDirectory = config.analysis_runtime?.skills_directory
      ? resolve(process.cwd(), config.analysis_runtime.skills_directory)
      : fileURLToPath(new URL("../../../packages/skills/", import.meta.url));
    const agentConfiguration = createAgentConfiguration({
      database: metadataDatabase,
      config: config.analysis_runtime,
      startupDirectory: process.cwd(),
      skillsDirectory,
    });
    const conversations = new ConversationService(conversationRepository, {
      ...(config.analysis_runtime?.enabled
        ? { dispatcher: { wake: () => runtime?.dispatcher.wake() } }
        : {}),
      authorizeRun: (context, runId) => runs.get(context, runId),
      selectAgent: (context, id, version) =>
        config.analysis_runtime?.enabled || id
          ? agentConfiguration.runtime.selectAgent(context, id, version)
          : Promise.resolve(undefined),
    });
    reporting = createReportServices({
      database: metadataDatabase,
      runs,
      catalog: businessCatalog,
      authorization: queryAuthorization,
      metrics,
      catalogForExecutor: memory.catalogForExecutor,
      authorizationForExecutor: memory.authorizationForExecutor,
      metricsForExecutor: memory.metricsForExecutor,
      access: memory.access,
      conversations: { get: (context, id) => conversations.get(context, id) },
      refreshContext: (context) => authService.refreshContext(context),
      ...(config.analysis_runtime?.enabled
        ? {
            selectAgent: async (
              context: Parameters<typeof agentConfiguration.runtime.selectAgent>[0],
              id?: string,
            ) => {
              const selected = await agentConfiguration.runtime.selectAgent(context, id);
              const agent = await agentConfiguration.agents.get(
                context,
                selected.agentId,
                selected.agentVersion,
              );
              if (
                !["get_report_definition", "save_report_definition"].every((name) =>
                  agent.tool_names.includes(name),
                )
              )
                throw new ApplicationError(
                  "INVALID_INPUT",
                  "请选择已启用报表定义读写工具的 Agent 新版本",
                );
              return selected;
            },
          }
        : {}),
      wake: () => runtime?.dispatcher.wake(),
    });
    const reports = reporting.reports;
    runtime = config.analysis_runtime?.enabled
      ? createAnalysisRuntime({
          config: config.analysis_runtime,
          database: metadataDatabase,
          runs,
          catalog: businessCatalog,
          metrics,
          reports,
          reportEditing: reporting.revisions,
          reportExecutions: reporting.executions,
          memory: memory.runtime,
          refreshContext: (context) => authService.refreshContext(context),
          agents: agentConfiguration.runtime,
          startupDirectory: process.cwd(),
          skillsDirectory,
          onError: (error) =>
            process.stderr.write(
              `分析调度失败: ${error instanceof ApplicationError ? error.code : "INTERNAL_ERROR"}\n`,
            ),
          listSourceIds: async () =>
            (await dataAccessRegistry.listHealthyServices()).flatMap((service) =>
              service.sources
                .filter((source) => source.status === "healthy")
                .map((source) => source.source_id),
            ),
        })
      : undefined;
    const app = await createApp({
      config,
      metadataDatabase,
      auth: authService,
      agentConfiguration,
      memory,
      reporting,
      conversations,
      analysis: { runs, metrics, reports },
      ...(runtime ? { runtime } : {}),
      dataAccess: {
        registry: dataAccessRegistry,
        catalogClient: dataAccessCatalogClient,
        managementClient: new DataAccessManagementClient(jwt),
      },
      catalog: {
        relations: new CatalogRelationService({
          repository: new SqlRelationRepository(metadataDatabase),
          rawCatalog,
          catalog: businessCatalog,
        }),
        service: businessCatalog,
        permissions: catalogRepository,
        admin: new CatalogAdminService({
          repository: catalogAdminRepository,
          catalog: businessCatalog,
          authorization: queryAuthorization,
        }),
      },
      query: {
        authorization: queryAuthorization,
        client: queryClient,
      },
    });
    app.addHook("onClose", async () => {
      await runtime?.close();
      await memory?.worker?.close();
      await metadataDatabase.close();
    });
    // 部署进程退出时先停派发、释放执行租约，再关闭元数据库连接。
    const shutdown = () => {
      void app.close().catch(() => {
        process.stderr.write("API 关闭失败\n");
        process.exitCode = 1;
      });
    };
    app.addHook("onClose", async () => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    });
    await app.listen({ host: config.service.host, port: config.service.port });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    await runtime?.close();
    await memory?.worker?.close();
    await metadataDatabase.close();
    throw error;
  }
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`API 启动失败: ${message}\n`);
  process.exitCode = 1;
});
