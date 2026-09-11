import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService } from "../../src/auth/auth-service";
import type { AuthRepository, AuthSession, AuthUser } from "../../src/auth/auth-types";
import { JwtService } from "../../src/auth/jwt-service";
import { hashPassword } from "../../src/auth/password";
import type { ApiConfig } from "../../src/config/api-config";

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

class MemoryAuthRepository implements AuthRepository {
  users = new Map<string, AuthUser>();
  sessions = new Map<string, AuthSession>();

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
    });
  }
}

describe("认证服务", () => {
  // BDD 场景：启用的本地用户提交正确密码；TDD 断言：创建会话并返回可校验的令牌。
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

  // BDD 场景：用户密码错误；TDD 断言：认证失败且不创建会话。
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

    await expect(service.login("admin", "wrong")).rejects.toThrow("账号或密码错误");
    expect(repository.sessions.size).toBe(0);
  });
});
