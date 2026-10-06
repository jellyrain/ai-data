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
import type { AnalysisRunService } from "./analysis-runs/analysis-run-service";
import type { MetricService } from "./metrics/metric-service";
import type { ReportService } from "./reports/report-service";
import type { CatalogAdminService } from "./catalog-admin/catalog-admin-service";
import type { AnalysisDispatcher } from "./runtime/runtime-types";
import type { SqlRuntimeRepository } from "./runtime/sql-runtime-repository";
import type { AgentService } from "./agents/agent-service";
import type { ModelService } from "./models/model-service";
import type { SkillCatalog } from "./skills/skill-catalog";
import type { PreferenceService } from "./preferences/preference-service";
import type { KnowledgeService } from "./knowledge/knowledge-service";
import type { SqlMemoryEventRepository } from "./memory/sql-memory-event-repository";
import type { MemoryDispatcher } from "./memory/memory-dispatcher";
import type { ReportDefinitionService } from "./reports/report-definition-service";
import type { ReportManagementService } from "./reports/report-management-service";
import type { ReportSharingService } from "./reports/report-sharing-service";
import type { ReportExecutionService } from "./reports/report-execution-service";
import type { ReportRevisionService } from "./reports/report-revision-service";
import type { CatalogRelationService } from "./catalog/catalog-relation-service";
import type { SqlUserAdminReader } from "./auth/sql-user-admin-reader";

/** 全部编辑入口共享报表定义与结果服务。 */
type ApiReportServices = {
  sharing: Pick<ReportSharingService, "get" | "candidates">;
  definitions: Pick<
    ReportDefinitionService,
    | "get"
    | "save"
    | "share"
    | "versions"
    | "list"
    | "getBlock"
    | "saveBlock"
    | "listBlocks"
    | "listTemplates"
  >;
  management: Pick<
    ReportManagementService,
    "list" | "versions" | "share" | "exportReport" | "exportConversation" | "artifacts"
  >;
  executions: Pick<ReportExecutionService, "execute" | "get" | "exportContent">;
  revisions: Pick<ReportRevisionService, "revise" | "narrate" | "narratives" | "binding">;
};

type ApiMemoryServices = {
  preferences: Pick<
    PreferenceService,
    "list" | "get" | "editState" | "save" | "delete" | "setAutoApply" | "listPendingConfirmations"
  >;
  knowledge: Pick<
    KnowledgeService,
    | "submit"
    | "submitMetric"
    | "listManagement"
    | "getManagement"
    | "ownerOptions"
    | "templateDefinition"
    | "getCandidate"
    | "listCandidates"
    | "listSources"
    | "support"
    | "update"
    | "withdraw"
    | "assignOwner"
    | "review"
    | "publish"
    | "listReviews"
    | "listPublished"
    | "getPublished"
    | "listVersions"
    | "setEnabled"
    | "rollback"
  >;
  events: Pick<SqlMemoryEventRepository, "list" | "retry">;
  worker?: Pick<MemoryDispatcher, "start" | "close">;
};

/** Agent 管理使用的模型、版本和公共资源目录能力。 */
type ApiAgentServices = {
  agents: Pick<AgentService, "publish" | "list" | "get" | "setEnabled">;
  models: Pick<ModelService, "publish" | "list" | "get" | "setEnabled">;
  skills: Pick<SkillCatalog, "list" | "read">;
};

/** 分析运行、指标执行和报告的 HTTP 服务边界。 */
type ApiAnalysisServices = {
  runs: Pick<
    AnalysisRunService,
    "get" | "events" | "evidence" | "steps" | "answer" | "cancel" | "execute"
  > &
    Partial<Pick<AnalysisRunService, "subscribeEvents">>;
  metrics: Pick<MetricService, "list" | "get" | "execute">;
  reports: Pick<ReportService, "save" | "get">;
};

/** HTTP 认证及用户管理所需的公开能力；服务实现的私有状态不进入装配边界。 */
type ApiAuthService = Pick<
  AuthService,
  | "login"
  | "refresh"
  | "logout"
  | "loadContext"
  | "refreshContext"
  | "createManagedUser"
  | "listManagedUsers"
  | "findManagedUser"
  | "updateManagedUserStatus"
  | "updateManagedUserDepartments"
>;
/** 会话路由使用的读写能力。 */
type ApiConversationService = Pick<
  ConversationService,
  "create" | "list" | "get" | "submitUserMessage"
>;
/** 用户目录读取与管理员配置维护所需的能力。 */
type ApiCatalogService = Pick<
  BusinessCatalogService,
  | "listAuthorized"
  | "searchAuthorized"
  | "getAuthorized"
  | "getAuthorizedConfig"
  | "saveConfig"
  | "getConfigVersion"
  | "listManaged"
  | "managedDetail"
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
  /** 管理选项及当前用户授权公开读取。 */
  userAdmin: Pick<SqlUserAdminReader, "options" | "roles" | "authorization">;
  /** 管理选项及当前用户授权公开读取。 */
  /** 会话、消息和分析运行服务。 */
  conversations: ApiConversationService;
  analysis: ApiAnalysisServices;
  agentConfiguration: ApiAgentServices;
  memory: ApiMemoryServices;
  reporting: ApiReportServices;
  /** DAS 实例发现与物理目录读取。 */
  dataAccess: {
    registry: Pick<
      DataAccessSessionService,
      | "register"
      | "heartbeat"
      | "issueCredential"
      | "exchangeCredential"
      | "listHealthyServices"
      | "listRegisteredServices"
    >;
    catalogClient: DataAccessCatalogClient;
    managementClient: Pick<DataAccessManagementClient, "execute" | "read" | "sqlServerTransport">;
  };
  /** 业务目录服务及角色权限持久化。 */
  catalog: {
    relations: Pick<CatalogRelationService, "graph" | "publish">;
    service: ApiCatalogService;
    permissions: CatalogPermissionRepository;
    admin: Pick<
      CatalogAdminService,
      | "saveObjectPermission"
      | "saveColumnPermission"
      | "saveRowPolicy"
      | "listVersions"
      | "getVersion"
      | "previewQuery"
      | "currentState"
    >;
  };
  /** 启用模型分析时必须装配调度器及审计读取能力。 */
  runtime?: {
    start(): Promise<void>;
    close(): Promise<void>;
    dispatcher: AnalysisDispatcher;
    repository: Pick<SqlRuntimeRepository, "listAudits">;
  };
  /** 查询授权与内部查询执行。 */
  query: { authorization: ApiQueryAuthorization; client: ApiQueryClient };
};

export type {
  ApiMemoryServices,
  ApiReportServices,
  ApiDependencies,
  ApiAuthService,
  ApiConversationService,
  ApiCatalogService,
  ApiQueryAuthorization,
  ApiQueryClient,
  ApiAnalysisServices,
  ApiAgentServices,
};
