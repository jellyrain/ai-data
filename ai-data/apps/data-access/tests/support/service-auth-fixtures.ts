import { createHash } from "node:crypto";
import { stableStringify } from "@ai-data/contracts";
import type { JWTPayload } from "jose";
import { InternalServiceVerifier } from "../../src/auth/internal-service-verifier";
import { createInternalToken, publicPem } from "./internal-query-fixtures";

/** 为真实路由验签生成符合 API 服务调用合同的临时令牌。 */
async function createServiceToken(
  method: string,
  path: string,
  body: unknown,
  claims: JWTPayload = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return createInternalToken({
    aud: "ai-data-das:data-access-test",
    sub: "api-test",
    token_use: path === "/internal/catalog" ? "das_catalog" : "das_management",
    request_hash: createHash("sha256")
      .update(stableStringify({ method, path, body: body ?? null }))
      .digest("base64url"),
    iat: now,
    nbf: now,
    exp: now + 60,
    ...claims,
  });
}

/** 验证测试 API 的签名并限制到指定实例。 */
function createServiceVerifier() {
  return InternalServiceVerifier.create(publicPem, "data-access-test");
}

export { createServiceToken, createServiceVerifier };
