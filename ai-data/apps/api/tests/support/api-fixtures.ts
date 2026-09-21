import { vi } from "vitest";
import type { ApiDependencies, ApiAnalysisServices, ApiCatalogService } from "../../src/app-types";
import type { AuthContext } from "../../src/auth/auth-types";
import type { ApiConfig } from "../../src/config/api-config";

/** 路由测试仅使用配置中的标识和运行模式，不会导入密钥或连接数据库。 */
const config: ApiConfig = {
  node_env: "test",
  service: { host: "127.0.0.1", port: 3000, service_id: "api-test", service_version: "1" },
  metadata_sqlserver: {
    server: "localhost",
    port: 1433,
    database: "test",
    user: "test",
    password: "test",
    options: {
      encrypt: false,
      trust_server_certificate: true,
      connection_timeout_ms: 5000,
      request_timeout_ms: 10000,
      pool: { max: 1, min: 0, idle_timeout_ms: 30000 },
    },
  },
  jwt: { issuer: "test", audience: "test", access_token_ttl_seconds: 900 },
};

/** 默认身份可管理目录和用户；权限拒绝场景会替换这一上下文。 */
const context: AuthContext = {
  userId: "user",
  organizationId: "org",
  sessionId: "session",
  roles: ["system_admin"],
  roleIds: ["admin"],
  permissions: [],
  dataPolicies: [],
};

/** 未参与场景的方法若被调用，立即暴露意外的业务路径。 */
async function unexpectedCall(): Promise<never> {
  throw new Error("测试未配置此调用");
}

/** 每个场景独立装配替身，只模拟服务边界，HTTP 注册和错误处理使用真实实现。 */
function createApiDependencies() {
  return {
    config,
    metadataDatabase: { checkHealth: vi.fn(async () => "healthy" as const) },
    auth: {
      loadContext: vi.fn(async () => context),
      refreshContext: vi.fn(async () => context),
      login: vi.fn(unexpectedCall),
      refresh: vi.fn(unexpectedCall),
      logout: vi.fn(async () => {}),
      createManagedUser: vi.fn(unexpectedCall),
      listManagedUsers: vi.fn(async () => []),
      findManagedUser: vi.fn(async () => null),
      updateManagedUserStatus: vi.fn(async () => false),
      updateManagedUserDepartments: vi.fn(async () => false),
    },
    conversations: {
      create: vi.fn(unexpectedCall),
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      submitUserMessage: vi.fn(async () => null),
    },
    memory: {
      preferences: {
        list: vi.fn(async () => []),
        get: vi.fn(unexpectedCall),
        save: vi.fn(unexpectedCall),
        delete: vi.fn(unexpectedCall),
        setAutoApply: vi.fn(unexpectedCall),
        listPendingConfirmations: vi.fn(async () => []),
      },
      knowledge: {
        submit: vi.fn(unexpectedCall),
        submitMetric: vi.fn(unexpectedCall),
        getCandidate: vi.fn(unexpectedCall),
        listCandidates: vi.fn(async () => []),
        listSources: vi.fn(async () => []),
        support: vi.fn(unexpectedCall),
        update: vi.fn(unexpectedCall),
        withdraw: vi.fn(unexpectedCall),
        assignOwner: vi.fn(unexpectedCall),
        review: vi.fn(unexpectedCall),
        publish: vi.fn(unexpectedCall),
        listReviews: vi.fn(async () => []),
        listPublished: vi.fn(async () => []),
        getPublished: vi.fn(unexpectedCall),
        listVersions: vi.fn(async () => []),
        setEnabled: vi.fn(unexpectedCall),
        rollback: vi.fn(unexpectedCall),
      },
      events: { list: vi.fn(async () => []), retry: vi.fn(unexpectedCall) },
    },
    agentConfiguration: {
      agents: {
        publish: vi.fn(unexpectedCall),
        get: vi.fn(unexpectedCall),
        list: vi.fn(async () => []),
        setEnabled: vi.fn(unexpectedCall),
      },
      models: {
        publish: vi.fn(unexpectedCall),
        get: vi.fn(unexpectedCall),
        list: vi.fn(async () => []),
        setEnabled: vi.fn(unexpectedCall),
      },
      skills: {
        list: vi.fn(() => []),
        read: vi.fn(() => {
          throw new Error("测试未配置此调用");
        }),
      },
    },
    analysis: {
      runs: {
        get: vi.fn<ApiAnalysisServices["runs"]["get"]>(unexpectedCall),
        events: vi.fn<ApiAnalysisServices["runs"]["events"]>(unexpectedCall),
        evidence: vi.fn(unexpectedCall),
        steps: vi.fn(unexpectedCall),
        answer: vi.fn(unexpectedCall),
        cancel: vi.fn(unexpectedCall),
        execute: vi.fn(unexpectedCall),
      },
      metrics: {
        list: vi.fn(unexpectedCall),
        get: vi.fn(unexpectedCall),
        execute: vi.fn(unexpectedCall),
      },
      reports: { save: vi.fn(unexpectedCall), get: vi.fn(unexpectedCall) },
    },
    reporting: {
      definitions: {
        get: vi.fn(unexpectedCall),
        save: vi.fn(unexpectedCall),
        share: vi.fn(unexpectedCall),
        versions: vi.fn(unexpectedCall),
        list: vi.fn(unexpectedCall),
        getBlock: vi.fn(unexpectedCall),
        saveBlock: vi.fn(unexpectedCall),
        listBlocks: vi.fn(unexpectedCall),
        listTemplates: vi.fn(unexpectedCall),
      },
      management: {
        list: vi.fn(unexpectedCall),
        versions: vi.fn(unexpectedCall),
        share: vi.fn(unexpectedCall),
        exportReport: vi.fn(unexpectedCall),
        exportConversation: vi.fn(unexpectedCall),
        artifacts: vi.fn(unexpectedCall),
      },
      executions: {
        execute: vi.fn(unexpectedCall),
        get: vi.fn(unexpectedCall),
        exportContent: vi.fn(unexpectedCall),
      },
      revisions: {
        revise: vi.fn(unexpectedCall),
        narrate: vi.fn(unexpectedCall),
        narratives: vi.fn(unexpectedCall),
      },
    },
    dataAccess: {
      registry: {
        register: vi.fn(unexpectedCall),
        heartbeat: vi.fn(async () => {}),
        issueCredential: vi.fn(unexpectedCall),
        listHealthyServices: vi.fn(async () => []),
      },
      catalogClient: { listCatalog: vi.fn(async () => []) },
      managementClient: { execute: vi.fn(unexpectedCall) },
    },
    catalog: {
      relations: { graph: vi.fn(unexpectedCall), publish: vi.fn(unexpectedCall) },
      admin: {
        saveObjectPermission: vi.fn(unexpectedCall),
        saveColumnPermission: vi.fn(unexpectedCall),
        saveRowPolicy: vi.fn(unexpectedCall),
        listVersions: vi.fn(unexpectedCall),
        getVersion: vi.fn(unexpectedCall),
        previewQuery: vi.fn(unexpectedCall),
      },
      service: {
        listAuthorized: vi.fn<ApiCatalogService["listAuthorized"]>(async () => []),
        searchAuthorized: vi.fn(async () => []),
        getAuthorized: vi.fn(async () => null),
        getAuthorizedConfig: vi.fn(async () => null),
        saveConfig: vi.fn(async () => {}),
        getConfigVersion: vi.fn(async () => 0),
      },
      permissions: {
        saveObjectPermission: vi.fn(async () => {}),
        saveColumnPermission: vi.fn(async () => {}),
        saveRowPolicy: vi.fn(async () => {}),
        listObjectPermissions: vi.fn(async () => []),
        listColumnPermissions: vi.fn(async () => []),
        listRowPolicies: vi.fn(async () => []),
      },
    },
    query: {
      authorization: { authorize: vi.fn(unexpectedCall) },
      client: { execute: vi.fn(unexpectedCall) },
    },
  } satisfies ApiDependencies;
}

export { config, context, createApiDependencies };
