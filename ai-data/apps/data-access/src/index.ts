import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";

import { createApp } from "./app";
import { CatalogService } from "./catalog/catalog-service";
import { loadApiVerificationPublicKey, loadDasConfig } from "./config/das-config";
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
import axios from "axios";
import dayjs from "dayjs";
import { QueryPlanner } from "./query-planning/query-planner";
import { QueryExecutionService } from "./query-execution/query-execution-service";
import { InternalQueryVerifier } from "./auth/internal-query-verifier";

/** DAS 随应用发布的唯一启动配置文件路径。 */
const defaultConfigPath = fileURLToPath(new URL("../config/das.config.json", import.meta.url));

/** SQL 迁移随应用发布，独立于 TypeScript bundle，便于数据库审阅和版本管理。 */
const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

/** 密钥库随 DAS 实例本地部署，不写入启动配置或元数据库。 */
const defaultKeyStoreDirectory = fileURLToPath(new URL("../secrets", import.meta.url));

/** 向 API 报告 DAS 实例状态；失败只记录日志，不阻断 DAS 提供本地服务。 */
async function sendHeartbeat(
  config: DasConfig,
  dataSourceRepository: DataSourceRepository,
  dataSourceManager: DataSourceManager,
  serviceProtocol: DataAccessHeartbeat["service_protocol"],
): Promise<void> {
  try {
    const sourceIds = await dataSourceRepository.listEnabledSourceIds();
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
    const response = await axios.post(
      `${config.api.base_url.replace(/\/$/, "")}${config.api.heartbeat_path}`,
      heartbeat,
      {
        headers: { "content-type": "application/json" },
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300)
      process.stderr.write(`DAS 心跳被 API 拒绝: HTTP ${response.status}\n`);
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
    const queryPlanner = new QueryPlanner(dataSourceRepository, exposedObjectRepository, {
      verify: async () => undefined,
    });
    const queryExecution = new QueryExecutionService(queryPlanner, dataSourceManager);
    const app = createApp(
      config,
      metadataDatabase,
      catalogService,
      managementService,
      queryExecution,
      queryVerifier,
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
    await sendHeartbeat(config, dataSourceRepository, dataSourceManager, serviceProtocol);
    heartbeatState.timer = setInterval(
      () => void sendHeartbeat(config, dataSourceRepository, dataSourceManager, serviceProtocol),
      30_000,
    );
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
