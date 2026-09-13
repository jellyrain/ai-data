import { createSign, generateKeyPairSync } from "node:crypto";
import { importPKCS8, SignJWT, type JWTPayload } from "jose";
import {
  dataAccessQueryRequestSchema,
  stableStringify,
  type DataAccessQueryRequest,
  type QueryAccessContext,
} from "@ai-data/contracts";

// 真实签发与验签使用本次测试生成的内存密钥。
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = new Date("2026-09-13T04:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

/** 构造已签名的完整合同请求，授权截止时间按东八区表达。 */
function createSignedRequest(
  access: Partial<QueryAccessContext> = {},
  query?: unknown,
): DataAccessQueryRequest {
  const request = dataAccessQueryRequestSchema.parse({
    access: {
      user_id: "user-001",
      organization_id: "org-001",
      analysis_run_id: "run-001",
      policy_version: 1,
      expires_at: "2026-09-13 12:00:55",
      output_masks: [
        {
          result_column: "phone",
          rule: { type: "partial_mask", prefix_length: 3, suffix_length: 0, mask_character: "*" },
        },
      ],
      ...access,
    },
    query: query ?? {
      type: "relational_query",
      source_id: "clinical",
      from: { object_id: "visit", alias: "v" },
      select: [{ field: "v.phone", as: "phone" }],
    },
    signature: "pending",
  });
  request.signature = createSign("RSA-SHA256")
    .update(stableStringify({ access: request.access, query: request.query }))
    .end()
    .sign(privateKey, "base64url");
  return request;
}

/** 签名保持有效，通过修改或省略 claims 测试授权规则。 */
async function createInternalToken(
  overrides: JWTPayload = {},
  omittedClaims: string[] = [],
): Promise<string> {
  const claims: JWTPayload = {
    iss: "ai-data-api:internal",
    aud: "ai-data-api:das",
    sub: "user-001",
    org_id: "org-001",
    token_use: "das_query",
    analysis_run_id: "run-001",
    policy_version: 1,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 60,
    jti: "query-token-001",
    ...overrides,
  };
  for (const claim of omittedClaims) delete claims[claim];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(await importPKCS8(privatePem, "RS256"));
}

export { createInternalToken, createSignedRequest, now, nowSeconds, publicPem };
