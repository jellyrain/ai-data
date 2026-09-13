import { createVerify } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { dateTimeSchema, stableStringify, type DataAccessQueryRequest } from "@ai-data/contracts";

/** 内部查询 JWT 的签发方标识，区别于其他用途的令牌。 */
const INTERNAL_QUERY_ISSUER = "ai-data-api:internal";
/** 内部查询 JWT 的 DAS 受众标识。 */
const INTERNAL_QUERY_AUDIENCE = "ai-data-api:das";

/** DAS 验证 API 内部查询令牌与请求签名。 */
class InternalQueryVerifier {
  private constructor(
    private readonly publicKey: Awaited<ReturnType<typeof importSPKI>>,
    private readonly publicPem: string,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  /** 在启动阶段导入 API 的 RS256 公钥，供后续请求复用。 */
  static async create(publicPem: string): Promise<InternalQueryVerifier> {
    const publicKey = await importSPKI(publicPem, "RS256");
    return new InternalQueryVerifier(
      publicKey,
      publicPem,
      INTERNAL_QUERY_ISSUER,
      INTERNAL_QUERY_AUDIENCE,
    );
  }

  /** 校验短时 JWT、请求身份一致性和整体签名，并执行 access 的授权截止时间。 */
  async verify(request: DataAccessQueryRequest, token: string): Promise<void> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256"],
      requiredClaims: [
        "iat",
        "nbf",
        "exp",
        "jti",
        "sub",
        "org_id",
        "analysis_run_id",
        "policy_version",
        "token_use",
      ],
      // API 内部查询令牌有效期为 60 秒，同时拒绝未来签发时间。
      maxTokenAge: 60,
    });
    // 两份签名共同授权同一身份和运行，阻止令牌与其他已签名上下文混用。
    if (
      typeof payload.jti !== "string" ||
      payload.jti.trim().length === 0 ||
      payload.token_use !== "das_query" ||
      payload.sub !== request.access.user_id ||
      payload.org_id !== request.access.organization_id ||
      payload.analysis_run_id !== request.access.analysis_run_id ||
      payload.policy_version !== request.access.policy_version
    ) {
      throw new Error("查询令牌身份字段无效或与访问上下文不一致");
    }
    // 整体签名覆盖审计上下文和最终 DSL，序列化规则需与签发端一致。
    const verifier = createVerify("RSA-SHA256");
    verifier.update(stableStringify({ access: request.access, query: request.query }));
    verifier.end();
    if (!verifier.verify(this.publicPem, request.signature, "base64url"))
      throw new Error("查询请求签名无效");

    // 合同使用东八区时间文本；显式偏移保证不同部署时区采用同一截止时刻。
    const expiresAt = dateTimeSchema.parse(request.access.expires_at);
    if (Date.parse(`${expiresAt.replace(" ", "T")}+08:00`) <= Date.now()) {
      throw new Error("查询访问上下文已过期");
    }
  }
}

export { InternalQueryVerifier };
