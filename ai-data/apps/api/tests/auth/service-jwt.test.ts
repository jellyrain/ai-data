import { createHash } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stableStringify } from "@ai-data/contracts";
import { createServiceJwt, privatePem, publicPem } from "../support/service-auth-fixtures";

describe("API 服务调用和实例接入凭证", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T04:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("目录请求令牌绑定实例、用途和请求内容摘要", async () => {
    const jwt = await createServiceJwt();
    const body = { source_id: "clinical" };
    const token = await jwt.signServiceRequest(
      "das-a",
      "das_catalog",
      "POST",
      "/internal/catalog",
      body,
    );
    const { payload } = await jwtVerify(token, await importSPKI(publicPem, "RS256"), {
      issuer: "ai-data-api:internal",
      audience: "ai-data-das:das-a",
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    expect(payload.token_use).toBe("das_catalog");
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(payload.request_hash).toBe(
      createHash("sha256")
        .update(stableStringify({ method: "POST", path: "/internal/catalog", body }))
        .digest("base64url"),
    );
  });

  it("长期实例凭证保持身份和版本，可用于重启后的重新注册", async () => {
    const jwt = await createServiceJwt();
    const credential = await jwt.signRegistrationCredential("das-a", 2);
    vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await expect(jwt.verifyRegistrationCredential(credential, "das-a")).resolves.toBe(2);
    await expect(jwt.verifyRegistrationCredential(credential, "das-b")).rejects.toThrow();
  });

  it.each([
    "expired",
    "issuer",
    "audience",
    "purpose",
    "future",
    "version",
    "missing-nbf",
    "signature",
  ])("注册拒绝 %s 凭证", async (scenario) => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: "ai-data-api:internal",
      aud: "ai-data-api:api-test:registration",
      sub: "das-a",
      token_use: "das_registration",
      credential_version: 1,
      iat: now,
      nbf: now,
      jti: "test-credential",
    };
    if (scenario === "expired") claims.exp = now;
    if (scenario === "issuer") claims.iss = "other";
    if (scenario === "audience") claims.aud = "other";
    if (scenario === "purpose") claims.token_use = "das_query";
    if (scenario === "future") claims.iat = now + 60;
    if (scenario === "version") claims.credential_version = "1";
    if (scenario === "missing-nbf") delete claims.nbf;
    let token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .sign(await importPKCS8(privatePem, "RS256"));
    if (scenario === "signature") token = "invalid";
    await expect(
      (await createServiceJwt()).verifyRegistrationCredential(token, "das-a"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });
});
