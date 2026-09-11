import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { JwtService } from "../../src/auth/jwt-service";
import type { ApiConfig } from "../../src/config/api-config";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const config = {
  node_env: "test",
  service: {
    host: "127.0.0.1",
    port: 3101,
    service_id: "ai-bi-api",
    service_version: "1.0.0",
  },
  metadata_sqlserver: {
    server: "localhost",
    port: 1433,
    database: "ai_bi_meta",
    user: "api_user",
    password: "secret",
    options: {
      encrypt: false,
      trust_server_certificate: true,
      connection_timeout_ms: 5000,
      request_timeout_ms: 10000,
      pool: { max: 10, min: 0, idle_timeout_ms: 30000 },
    },
  },
  jwt: {
    issuer: "ai-data-api",
    audience: "ai-data-api",
    access_token_ttl_seconds: 900,
    signing_private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    verification_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
} satisfies ApiConfig;

describe("API JWT 服务", () => {
  // BDD 场景：已建立本地会话；TDD 断言：签发的令牌包含内部身份和会话定位字段。
  it("签发并校验 Access JWT", async () => {
    const service = await JwtService.create(config);
    const token = await service.signAccessToken({
      userId: "user-001",
      sessionId: "session-001",
      organizationId: "organization-001",
      authorizationVersion: 3,
    });

    const claims = await service.verifyAccessToken(token);

    expect(claims.sub).toBe("user-001");
    expect(claims.sid).toBe("session-001");
    expect(claims.org_id).toBe("organization-001");
    expect(claims.authz_version).toBe(3);
  });

  // BDD 场景：客户端篡改令牌内容；TDD 断言：非 API 私钥签发的令牌被拒绝。
  it("拒绝被篡改的 Access JWT", async () => {
    const service = await JwtService.create(config);
    const token = await service.signAccessToken({
      userId: "user-001",
      sessionId: "session-001",
      organizationId: "organization-001",
      authorizationVersion: 1,
    });
    const [header, payload, signature] = token.split(".");
    const tamperedToken = `${header}.${payload}.${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;

    await expect(service.verifyAccessToken(tamperedToken)).rejects.toThrow();
  });
});
