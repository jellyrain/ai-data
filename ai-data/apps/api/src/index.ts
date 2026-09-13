import { fileURLToPath } from "node:url";

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
    const businessCatalog = new BusinessCatalogService(
      new RegisteredDataAccessCatalog(dataAccessRegistry, dataAccessCatalogClient),
      catalogRepository,
      catalogRepository,
    );
    const queryAuthorization = new QueryAuthorizationService(businessCatalog, jwt);
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
    const app = await createApp({
      config,
      metadataDatabase,
      auth: new AuthService({
        repository: authRepository,
        jwt,
        contextCache: new AuthContextCache(),
      }),
      conversations: new ConversationService(conversationRepository),
      dataAccess: {
        registry: dataAccessRegistry,
        catalogClient: dataAccessCatalogClient,
        managementClient: new DataAccessManagementClient(jwt),
      },
      catalog: { service: businessCatalog, permissions: catalogRepository },
      query: {
        authorization: queryAuthorization,
        client: new DataAccessQueryClient(dataAccessRegistry),
      },
    });
    app.addHook("onClose", async () => metadataDatabase.close());
    await app.listen({ host: config.service.host, port: config.service.port });
  } catch (error) {
    await metadataDatabase.close();
    throw error;
  }
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`API 启动失败: ${message}\n`);
  process.exitCode = 1;
});
