import type { MetadataDatabaseHealthChecker } from "@ai-data/metadata";
import type { ApiConfig } from "./config/api-config";
import type { AuthService } from "./auth/auth-service";
import type { ConversationService } from "./conversations/conversation-service";
import type { BusinessCatalogService } from "./catalog/business-catalog-service";
import type { CatalogPermissionRepository } from "./catalog/catalog-types";
import type { DataAccessCatalogClient } from "./data-access/data-access-types";
import type { DataAccessQueryClient } from "./data-access/data-access-query-client";
import type { QueryAuthorizationService } from "./query/query-authorization-service";
import type { DataAccessSessionService } from "./data-access/data-access-session-service";
import type { DataAccessManagementClient } from "./data-access/data-access-management-client";

/** HTTP 认证及用户管理所需的公开能力；服务实现的私有状态不进入装配边界。 */
type ApiAuthService = Pick<
  AuthService,
  | "login"
  | "refresh"
  | "logout"
  | "loadContext"
  | "createManagedUser"
  | "listManagedUsers"
  | "findManagedUser"
  | "updateManagedUserStatus"
>;
/** 会话路由使用的读写能力。 */
type ApiConversationService = Pick<
  ConversationService,
  "create" | "list" | "get" | "submitUserMessage"
>;
/** 用户目录读取与管理员配置维护所需的能力。 */
type ApiCatalogService = Pick<
  BusinessCatalogService,
  "listAuthorized" | "searchAuthorized" | "getAuthorized" | "getAuthorizedConfig" | "saveConfig"
>;
/** 查询路由依次调用授权服务和 DAS 客户端。 */
type ApiQueryAuthorization = Pick<QueryAuthorizationService, "authorize">;
/** 执行已授权签名查询并返回标准结果的客户端能力。 */
type ApiQueryClient = Pick<DataAccessQueryClient, "execute">;

/** 当前 API 启用模块的完整装配合同；测试单个模块时可直接注册对应路由。 */
type ApiDependencies = {
  /** 已校验的启动配置，负责日志标识和生产 Cookie 设置。 */
  config: ApiConfig;
  /** 就绪探针使用的元数据库健康检查能力。 */
  metadataDatabase: MetadataDatabaseHealthChecker;
  /** 登录、身份加载及用户管理服务。 */
  auth: ApiAuthService;
  /** 会话、消息和分析运行服务。 */
  conversations: ApiConversationService;
  /** DAS 实例发现与物理目录读取。 */
  dataAccess: {
    registry: Pick<
      DataAccessSessionService,
      "register" | "heartbeat" | "issueCredential" | "listHealthyServices"
    >;
    catalogClient: DataAccessCatalogClient;
    managementClient: Pick<DataAccessManagementClient, "execute">;
  };
  /** 业务目录服务及角色权限持久化。 */
  catalog: { service: ApiCatalogService; permissions: CatalogPermissionRepository };
  /** 查询授权与内部查询执行。 */
  query: { authorization: ApiQueryAuthorization; client: ApiQueryClient };
};

export type {
  ApiDependencies,
  ApiAuthService,
  ApiConversationService,
  ApiCatalogService,
  ApiQueryAuthorization,
  ApiQueryClient,
};
