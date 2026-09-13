import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JWTPayload } from "jose";
import { createServiceToken, createServiceVerifier } from "../support/service-auth-fixtures";

describe("DAS 目录与管理请求验签", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T04:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it.each(["/internal/catalog", "/internal/admin/data-sources"])(
    "接受正确签名的 %s",
    async (path) => {
      const body = { source_id: "clinical" };
      const verifier = await createServiceVerifier();
      const purpose = path === "/internal/catalog" ? "das_catalog" : "das_management";
      await expect(
        verifier.verify(await createServiceToken("POST", path, body), purpose, "POST", path, body),
      ).resolves.toBeUndefined();
    },
  );

  it.each<{ scenario: string; claims: JWTPayload }>([
    { scenario: "其他实例受众", claims: { aud: "ai-data-das:another" } },
    { scenario: "其他签发方", claims: { iss: "other" } },
    { scenario: "查询令牌用途", claims: { token_use: "das_query" } },
    { scenario: "管理令牌用途", claims: { token_use: "das_management" } },
    { scenario: "过期", claims: { exp: 0 } },
    { scenario: "未生效", claims: { nbf: 9_999_999_999 } },
    { scenario: "空标识", claims: { jti: "" } },
  ])("拒绝$scenario 的令牌", async ({ claims }) => {
    const verifier = await createServiceVerifier();
    const token = await createServiceToken("POST", "/internal/catalog", {}, claims);
    await expect(
      verifier.verify(token, "das_catalog", "POST", "/internal/catalog", {}),
    ).rejects.toThrow();
  });

  it.each(["method", "path", "body", "signature"])("拒绝被修改的 %s", async (part) => {
    const verifier = await createServiceVerifier();
    let token = await createServiceToken("POST", "/internal/catalog", { source_id: "clinical" });
    if (part === "signature") {
      const parts = token.split(".");
      parts[2] = (parts[2].startsWith("a") ? "b" : "a") + parts[2].slice(1);
      token = parts.join(".");
    }
    await expect(
      verifier.verify(
        token,
        "das_catalog",
        part === "method" ? "PUT" : "POST",
        part === "path" ? "/internal/admin/data-sources" : "/internal/catalog",
        { source_id: part === "body" ? "other" : "clinical" },
      ),
    ).rejects.toThrow();
  });
});
