import { createHash } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { stableStringify } from "@ai-data/contracts";

/** DAS 目录和管理调用的 API 身份、用途与请求内容校验。 */
class InternalServiceVerifier {
  private constructor(
    private readonly publicKey: Awaited<ReturnType<typeof importSPKI>>,
    private readonly serviceId: string,
  ) {}

  static async create(publicPem: string, serviceId: string): Promise<InternalServiceVerifier> {
    return new InternalServiceVerifier(await importSPKI(publicPem, "RS256"), serviceId);
  }

  /** 令牌绑定目标实例、操作用途、HTTP 方法、路径和请求体摘要。 */
  async verify(
    token: string,
    purpose: "das_catalog" | "das_management",
    method: string,
    path: string,
    body: unknown,
  ): Promise<void> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: "ai-data-api:internal",
      audience: `ai-data-das:${this.serviceId}`,
      algorithms: ["RS256"],
      maxTokenAge: 60,
      requiredClaims: ["sub", "iat", "nbf", "exp", "jti", "token_use", "request_hash"],
    });
    const hash = createHash("sha256")
      .update(stableStringify({ method, path, body: body ?? null }))
      .digest("base64url");
    if (
      typeof payload.sub !== "string" ||
      !payload.sub.trim() ||
      typeof payload.jti !== "string" ||
      !payload.jti.trim() ||
      payload.token_use !== purpose ||
      payload.request_hash !== hash
    )
      throw new Error("内部服务请求验证失败");
  }
}

export { InternalServiceVerifier };
