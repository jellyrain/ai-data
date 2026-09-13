import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";

import { createApp } from "./app";
import { CatalogService } from "./catalog/catalog-service";
import {
  loadApiVerificationPublicKey,
  loadDasConfig,
  loadRegistrationCredential,
} from "./config/das-config";
import type { DasConfig } from "./config/das-config";
import { DataSourceManager } from "./data-sources/data-source-manager";
import { DataSourceManagementService } from "./data-sources/data-source-management-service";
import { DatabaseServerTargetDiscovery } from "./data-sources/database-target-discovery";
import { DefaultConnectorFactory } from "./connectors/default-connector-factory";
import { ApiDatasetRepository } from "./metadata/api-dataset-repository";
import { DataSourceRepository } from "./metadata/data-source-repository";
import { ExposedObjectRepository } from "./metadata/exposed-object-repository";
import { SecretRepository } from "./metadata/secret-repository";
import { LocalMasterKeyStore } from "./secrets/local-master-key-store";
import { SecretResolver } from "./secrets/secret-resolver";
import { Aes256GcmSecretCipher } from "./secrets/aes-256-gcm-secret-cipher";
import type { DataAccessHeartbeat } from "@ai-data/contracts";
import dayjs from "dayjs";
import { QueryPlanner } from "./query-planning/query-planner";
import { QueryExecutionService } from "./query-execution/query-execution-service";
import { InternalQueryVerifier } from "./auth/internal-query-verifier";
import { InternalServiceVerifier } from "./auth/internal-service-verifier";
import { DataAccessHeartbeatClient } from "./api/data-access-heartbeat-client";
import { AuditRepository } from "./metadata/audit-repository";

/** DAS 随应用发布的唯一启动配置文件路径。 */
const defaultConfigPath = fileURLToPath(new URL("../config/das.config.json", import.meta.url));

/** SQL 迁移随应用发布，独立于 TypeScript bundle，便于数据库审阅和版本管理。 */
const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

/** DAS 实例本地密钥目录，保存解密业务凭据所需的主密钥及活动版本。 */
const defaultKeyStoreDirectory = fileURLToPath(new URL("../secrets", import.meta.url));

/** 向 API 报告 DAS 实例状态；失败只记录日志，不阻断 DAS 提供本地服务。 */
async function sendHeartbeat(
  config: DasConfig,
  dataSourceRepository: DataSourceRepository,
  dataSourceManager: DataSourceManager,
  serviceProtocol: DataAccessHeartbeat["service_protocol"],
  client: DataAccessHeartbeatClient,
): Promise<void> {
  try {
    const sourceIds = await dataSourceRepository.listEnabledSourceIds();
    // 每个数据源单独探测；个别失败仍随同其他源的状态一起上报。
    const sources = await Promise.all(
      sourceIds.map(async (sourceId) => {
        try {
          return await (await dataSourceManager.get(sourceId)).checkHealth();
        } catch {
          return {
            source_id: sourceId,
            status: "unhealthy" as const,
            checked_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
          };
        }
      }),
    );
    const heartbeat: DataAccessHeartbeat = {
      service_id: config.service.service_id,
      service_port: config.service.port,
      service_protocol: serviceProtocol,
      status: "healthy",
      sent_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      service_version: config.service.service_version,
      sources,
    };
    await client.send(heartbeat);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DAS 心跳发送失败: ${message}\n`);
  }
}

/** 加载配置、初始化 DAS 元数据表，并启动内部 HTTP 服务。 */
async function start(): Promise<void> {
  const config = loadDasConfig(defaultConfigPath);
  // 在 DAS 启动阶段读取 API 公钥文件，后续 JWT 验签器复用已加载内容。
  const apiPublicKey = loadApiVerificationPublicKey(config, dirname(defaultConfigPath));
  loadRegistrationCredential(config, dirname(defaultConfigPath));
  const heartbeatClient = new DataAccessHeartbeatClient(config.api, () =>
    loadRegistrationCredential(config, dirname(defaultConfigPath)),
  );
  const masterKeyStore = new LocalMasterKeyStore(defaultKeyStoreDirectory);
  await masterKeyStore.getActiveKey();
  const metadataDatabase = await SqlServerMetadataDatabase.connect(config.metadata_sqlserver);

  try {
    await metadataDatabase.initializeSchema(defaultMigrationsDirectory);
    const dataSourceRepository = new DataSourceRepository(metadataDatabase);
    const exposedObjectRepository = new ExposedObjectRepository(metadataDatabase);
    const secretRepository = new SecretRepository(metadataDatabase);
    const apiDatasetRepository = new ApiDatasetRepository(metadataDatabase);
    const secretResolver = new SecretResolver(secretRepository, masterKeyStore);
    const dataSourceManager = new DataSourceManager(
      dataSourceRepository,
      secretResolver,
      new DefaultConnectorFactory(apiDatasetRepository),
    );
    const catalogService = new CatalogService(dataSourceManager, exposedObjectRepository);
    const managementService = new DataSourceManagementService(
      secretRepository,
      dataSourceRepository,
      exposedObjectRepository,
      secretResolver,
      masterKeyStore,
      new Aes256GcmSecretCipher(),
      new DatabaseServerTargetDiscovery(),
      dataSourceManager,
    );
    const queryVerifier = await InternalQueryVerifier.create(apiPublicKey);
    const serviceVerifier = await InternalServiceVerifier.create(
      apiPublicKey,
      config.service.service_id,
    );
    // 查询路由已先执行 InternalQueryVerifier，此处规划器复用该调用顺序，不重复验签。
    const queryPlanner = new QueryPlanner(
      dataSourceRepository,
      exposedObjectRepository,
      {
        verify: async () => undefined,
      },
      apiDatasetRepository,
    );
    const queryExecution = new QueryExecutionService(queryPlanner, dataSourceManager);
    const app = createApp(
      config,
      metadataDatabase,
      catalogService,
      managementService,
      queryExecution,
      queryVerifier,
      serviceVerifier,
      new AuditRepository(metadataDatabase),
    );
    // Fastify 开始监听后不能再注册 Hook；定时器在监听成功后创建，避免上报错误协议。
    const heartbeatState: { timer: NodeJS.Timeout | undefined } = { timer: undefined };

    app.addHook("onClose", async () => {
      if (heartbeatState.timer) clearInterval(heartbeatState.timer);
      await dataSourceManager.close();
      await metadataDatabase.close();
    });

    const listenAddress = await app.listen({
      host: config.service.host,
      port: config.service.port,
    });
    const serviceProtocol: DataAccessHeartbeat["service_protocol"] =
      new URL(listenAddress).protocol === "https:" ? "https" : "http";
    let isSendingHeartbeat = false;
    const publishHeartbeat = async () => {
      if (isSendingHeartbeat) return;
      isSendingHeartbeat = true;
      try {
        await sendHeartbeat(
          config,
          dataSourceRepository,
          dataSourceManager,
          serviceProtocol,
          heartbeatClient,
        );
      } finally {
        isSendingHeartbeat = false;
      }
    };
    await publishHeartbeat();
    // 监听成功后每 30 秒汇总一次数据源状态，关闭 Hook 负责清除定时器。
    heartbeatState.timer = setInterval(() => void publishHeartbeat(), 30_000);
  } catch (error) {
    await metadataDatabase.close();
    throw error;
  }
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`DAS 启动失败: ${message}\n`);
  process.exitCode = 1;
});
