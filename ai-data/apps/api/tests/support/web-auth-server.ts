import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import { AuthService } from "../../src/auth/auth-service";
import type {
  UserAdminRepository,
  AuthSession,
  AuthUser,
  CreateUserInput,
  UserStatus,
} from "../../src/auth/auth-types";
import { JwtService } from "../../src/auth/jwt-service";
import { hashPassword } from "../../src/auth/password";
import type { ApiConfig } from "../../src/config/api-config";
import { registerAuthRoutes, bearerToken } from "../../src/routes/auth-routes";
import { registerContractErrorHandler } from "../../src/routes/contract-error";
import { registerWebAnalysisFixture } from "./web-analysis-fixture";
import { registerWebReportFixture } from "./web-report-fixture";
import { registerWebEditorCatalogFixture } from "./web-editor-catalog-fixture";

/** 仅由 Web 浏览器验收启动，所有用户、密钥和会话随进程结束销毁。 */
class WebAuthRepository implements UserAdminRepository {
  users = new Map<string, AuthUser>();
  sessions = new Map<string, AuthSession>();
  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const user: AuthUser = { ...input, status: "active", authorizationVersion: 1 };
    this.users.set(user.id, user);
    return user;
  }
  async listUsers(organizationId: string) {
    return [...this.users.values()].filter((user) => user.organizationId === organizationId);
  }
  async updateUserStatus(id: string, organizationId: string, status: UserStatus) {
    const user = this.users.get(id);
    if (!user || user.organizationId !== organizationId) return false;
    user.status = status;
    user.authorizationVersion++;
    return true;
  }
  async ensureBootstrapAdmin(): Promise<void> {
    throw new Error("浏览器验收只使用内存测试用户");
  }
  async updateUserDepartments(): Promise<boolean> {
    throw new Error("浏览器验收不修改部门");
  }
  async findUserByUsername(username: string) {
    return [...this.users.values()].find((user) => user.username === username) ?? null;
  }
  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async findSessionById(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async createSession(session: AuthSession) {
    this.sessions.set(session.id, session);
  }
  async rotateSession(id: string, refreshTokenHash: string, expiresAt: Date) {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt) return null;
    Object.assign(session, { refreshTokenHash, expiresAt });
    return session;
  }
  async revokeSession(id: string) {
    const session = this.sessions.get(id);
    if (session) session.revokedAt = new Date();
  }
  async loadAuthorization(id: string) {
    return {
      roles: [id === "test-admin" ? "system_admin" : "analyst"],
      permissions: ["analysis:execute"],
      dataPolicies: [],
    };
  }
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: ApiConfig = {
  node_env: "test",
  service: { host: "127.0.0.1", port: 4318, service_id: "web-auth-test", service_version: "1" },
  metadata_sqlserver: {
    server: "unused",
    port: 1433,
    database: "unused",
    user: "unused",
    password: "unused",
    options: {
      encrypt: false,
      trust_server_certificate: true,
      connection_timeout_ms: 5000,
      request_timeout_ms: 10000,
      pool: { max: 1, min: 0, idle_timeout_ms: 30000 },
    },
  },
  jwt: {
    issuer: "web-auth-test",
    audience: "web-auth-test",
    access_token_ttl_seconds: 900,
    signing_private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    verification_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
};
const repository = new WebAuthRepository();
for (const username of ["admin", "analyst", "editor"]) {
  await repository.createUser({
    id: `test-${username}`,
    organizationId: "test-organization",
    username,
    displayName: username === "admin" ? "测试管理员" : "分析员 · 华东业务数据运营团队",
    passwordHash: await hashPassword("Web-test-2026!"),
    roleIds: [],
    exceptionDataScopeIds: [],
  });
}
const auth = new AuthService({ repository, jwt: await JwtService.create(config) });
const app = Fastify({ logger: false });
registerContractErrorHandler(app);
registerAuthRoutes(app, auth, false);
const analysis = registerWebAnalysisFixture(app, auth);
registerWebReportFixture(app, auth, analysis);
registerWebEditorCatalogFixture(app, auth);
app.get("/health", async () => ({ status: "ok" }));
app.get("/test/identity", async (request) => auth.loadContext(bearerToken(request)));
await app.listen({ host: "127.0.0.1", port: Number(process.env.WEB_AUTH_TEST_PORT ?? 4318) });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
