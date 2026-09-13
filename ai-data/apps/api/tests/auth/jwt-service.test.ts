import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JwtService } from "../../src/auth/jwt-service";
import type { ApiConfig } from "../../src/config/api-config";

// 用临时密钥执行真实 RS256 签发与验签，覆盖篡改后签名被拒绝的行为。
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
  afterEach(() => vi.useRealTimers());

  it("内部查询令牌包含必需身份和时间字段，生效后持续 60 秒", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T04:00:00Z"));
    const service = await JwtService.create(config);
    const token = await service.signInternalQueryToken({
      userId: "user-001",
      organizationId: "org-001",
      analysisRunId: "run-001",
      policyVersion: 3,
    });
    const key = await importSPKI(config.jwt.verification_public_key_pem, "RS256");
    const { payload } = await jwtVerify(token, key, {
      issuer: "ai-data-api:internal",
      audience: "ai-data-api:das",
      algorithms: ["RS256"],
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    const issuedAt = Math.floor(Date.now() / 1000);
    expect(payload).toMatchObject({
      sub: "user-001",
      org_id: "org-001",
      analysis_run_id: "run-001",
      policy_version: 3,
      token_use: "das_query",
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + 60,
      jti: expect.any(String),
    });
  });

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

    await expect(service.verifyAccessToken(tamperedToken)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      cause: expect.any(Error),
    });
  });
});
