import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService } from "../../src/auth/auth-service";
import type {
  UserAdminRepository,
  CreateUserInput,
  UserStatus,
  AuthSession,
  AuthUser,
  AuthContext,
} from "../../src/auth/auth-types";
import { JwtService } from "../../src/auth/jwt-service";
import { hashPassword } from "../../src/auth/password";
import type { ApiConfig } from "../../src/config/api-config";

// 每个测试进程生成临时 RSA 密钥，认证与轮换使用真实签发和密码派生实现。
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  node_env: "test",
  service: { host: "127.0.0.1", port: 3101, service_id: "api", service_version: "1" },
  metadata_sqlserver: {
    server: "localhost",
    port: 1433,
    database: "meta",
    user: "user",
    password: "password",
    options: {
      encrypt: false,
      trust_server_certificate: true,
      connection_timeout_ms: 5000,
      request_timeout_ms: 10000,
      pool: { max: 1, min: 0, idle_timeout_ms: 30000 },
    },
  },
  jwt: {
    issuer: "api",
    audience: "api",
    access_token_ttl_seconds: 900,
    signing_private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    verification_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
} satisfies ApiConfig;

/** 内存仓储保留用户和会话状态，供登录、轮换和管理能力场景共享。 */
class MemoryAuthRepository implements UserAdminRepository {
  users = new Map<string, AuthUser>();
  sessions = new Map<string, AuthSession>();
  permissionContext?: AuthContext["permissionContext"];

  createUser(input: CreateUserInput): Promise<AuthUser> {
    const user: AuthUser = { ...input, status: "active", authorizationVersion: 1 };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }
  listUsers(organizationId: string): Promise<AuthUser[]> {
    return Promise.resolve(
      [...this.users.values()].filter((user) => user.organizationId === organizationId),
    );
  }
  updateUserStatus(userId: string, organizationId: string, status: UserStatus): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.organizationId !== organizationId) return Promise.resolve(false);
    user.status = status;
    user.authorizationVersion++;
    return Promise.resolve(true);
  }
  ensureBootstrapAdmin(): Promise<void> {
    throw new Error("此测试不执行管理员初始化");
  }
  async updateUserDepartments(
    userId: string,
    organizationId: string,
    departmentIds: string[],
  ): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.organizationId !== organizationId) return false;
    this.permissionContext = { department_ids: departmentIds };
    user.authorizationVersion++;
    return true;
  }

  findUserByUsername(username: string) {
    return Promise.resolve(
      [...this.users.values()].find((user) => user.username === username) ?? null,
    );
  }
  findUserById(userId: string) {
    return Promise.resolve(this.users.get(userId) ?? null);
  }
  findSessionById(sessionId: string) {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }
  createSession(session: AuthSession) {
    this.sessions.set(session.id, session);
    return Promise.resolve();
  }
  rotateSession(sessionId: string, refreshTokenHash: string, expiresAt: Date) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.refreshTokenHash = refreshTokenHash;
      session.expiresAt = expiresAt;
    }
    return Promise.resolve(session ?? null);
  }
  revokeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.revokedAt = new Date();
    return Promise.resolve();
  }
  loadAuthorization() {
    return Promise.resolve({
      roles: ["analyst"],
      roleIds: ["role-analyst"],
      permissions: ["analysis:execute"],
      dataPolicies: [],
      permissionContext: this.permissionContext,
    });
  }
}

describe("认证服务", () => {
  it("从可信仓储加载权限范围到当前身份上下文", async () => {
    const repository = new MemoryAuthRepository();
    repository.permissionContext = { department_ids: ["department-a", "department-b"] };
    repository.users.set("user-001", {
      id: "user-001",
      organizationId: "org-001",
      username: "analyst",
      displayName: "分析员",
      passwordHash: null,
      status: "active",
      authorizationVersion: 1,
    });
    repository.sessions.set("session-001", {
      id: "session-001",
      userId: "user-001",
      refreshTokenHash: "test-hash",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    const jwt = await JwtService.create(config);
    const token = await jwt.signAccessToken({
      userId: "user-001",
      organizationId: "org-001",
      sessionId: "session-001",
      authorizationVersion: 1,
    });
    const service = new AuthService({ repository, jwt });

    const context = await service.loadContext(token);

    expect(context.permissionContext).toEqual({ department_ids: ["department-a", "department-b"] });
    expect(context.userId).toBe("user-001");
    expect(context.organizationId).toBe("org-001");
  });
  it("完成本地登录和刷新令牌轮换", async () => {
    const repository = new MemoryAuthRepository();
    repository.users.set("user-001", {
      id: "user-001",
      organizationId: "org-001",
      username: "admin",
      displayName: "管理员",
      passwordHash: await hashPassword("secret"),
      status: "active",
      authorizationVersion: 1,
    });
    const service = new AuthService({ repository, jwt: await JwtService.create(config) });

    const loggedIn = await service.login("admin", "secret");
    const context = await service.loadContext(loggedIn.accessToken);
    const refreshed = await service.refresh(loggedIn.refreshToken);

    expect(context.userId).toBe("user-001");
    expect(refreshed.refreshToken).not.toBe(loggedIn.refreshToken);
    await expect(service.refresh(loggedIn.refreshToken)).rejects.toThrow();
  });

  it("拒绝错误密码", async () => {
    const repository = new MemoryAuthRepository();
    repository.users.set("user-001", {
      id: "user-001",
      organizationId: "org-001",
      username: "admin",
      displayName: "管理员",
      passwordHash: await hashPassword("secret"),
      status: "active",
      authorizationVersion: 1,
    });
    const service = new AuthService({ repository, jwt: await JwtService.create(config) });

    await expect(service.login("admin", "wrong")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "账号或密码错误",
    });
    expect(repository.sessions.size).toBe(0);
  });
});
