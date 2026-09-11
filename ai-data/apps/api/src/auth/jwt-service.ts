import { createSign } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { stableStringify, type QueryAccessContext, type QueryDsl } from "@ai-data/contracts";

import type { ApiConfig } from "../config/api-config";
import { LocalJwtKeyStore } from "./local-jwt-key-store";

/** API 与 DAS 约定的内部查询令牌来源和受众。 */
const INTERNAL_QUERY_ISSUER = "ai-data-api:internal";
const INTERNAL_QUERY_AUDIENCE = "ai-data-api:das";

/** 已完成签名、签发方和受众校验的 Access JWT 身份载荷。 */
type AccessTokenClaims = {
  /** API 本地用户主键。 */
  sub: string;
  /** 服务端 Refresh Token 会话主键。 */
  sid: string;
  /** 用户所属组织主键。 */
  org_id: string;
  /** 签发时的用户授权版本。 */
  authz_version: number;
  /** JWT 签发方。 */
  iss: string;
  /** JWT 允许的受众。 */
  aud: string | string[];
  /** 签发时间，Unix 秒。 */
  iat: number;
  /** 过期时间，Unix 秒。 */
  exp: number;
};

/** 签发 Access JWT 所需的本地会话身份。 */
type AccessTokenInput = {
  /** API 本地用户主键。 */
  userId: string;
  /** 服务端 Refresh Token 会话主键。 */
  sessionId: string;
  /** 用户所属组织主键。 */
  organizationId: string;
  /** 当前用户授权版本。 */
  authorizationVersion: number;
};

/** API 调用 DAS 时使用的短时内部令牌载荷。 */
type InternalQueryTokenInput = {
  userId: string;
  organizationId: string;
  analysisRunId: string;
  policyVersion: number;
};

/** API 使用的 Access JWT 签发和校验服务；令牌只携带身份与会话定位信息。 */
class JwtService {
  private constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly accessTokenTtl: number,
    private readonly signingKey: Awaited<ReturnType<typeof importPKCS8>>,
    private readonly verificationKey: Awaited<ReturnType<typeof importSPKI>>,
    private readonly signingPem: string,
  ) {}

  /** 从 API 配置导入非对称密钥，避免业务请求处理时重复解析 PEM。 */
  static async create(config: ApiConfig, keyDirectory?: string): Promise<JwtService> {
    const localKeys =
      config.jwt.signing_private_key_pem && config.jwt.verification_public_key_pem
        ? {
            privateKeyPem: config.jwt.signing_private_key_pem,
            publicKeyPem: config.jwt.verification_public_key_pem,
          }
        : await new LocalJwtKeyStore(
            keyDirectory ?? config.jwt.key_directory ?? "./keys",
          ).getKeyPair();
    const [signingKey, verificationKey] = await Promise.all([
      importPKCS8(localKeys.privateKeyPem, "RS256"),
      importSPKI(localKeys.publicKeyPem, "RS256"),
    ]);

    return new JwtService(
      config.jwt.issuer,
      config.jwt.audience,
      config.jwt.access_token_ttl_seconds,
      signingKey,
      verificationKey,
      localKeys.privateKeyPem,
    );
  }

  /** 为已创建的 API 会话签发短时 Access JWT。 */
  async signAccessToken(input: AccessTokenInput): Promise<string> {
    return new SignJWT({
      sid: input.sessionId,
      org_id: input.organizationId,
      authz_version: input.authorizationVersion,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(input.userId)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime(`${this.accessTokenTtl}s`)
      .sign(this.signingKey);
  }

  /** 为单次查询签发面向 DAS 的短时内部 JWT。 */
  async signInternalQueryToken(input: InternalQueryTokenInput): Promise<string> {
    return new SignJWT({
      token_use: "das_query",
      org_id: input.organizationId,
      analysis_run_id: input.analysisRunId,
      policy_version: input.policyVersion,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(INTERNAL_QUERY_ISSUER)
      .setAudience(INTERNAL_QUERY_AUDIENCE)
      .setSubject(input.userId)
      .setIssuedAt()
      .setJti(crypto.randomUUID())
      .setExpirationTime("60s")
      .sign(this.signingKey);
  }

  /** 对 access 与 query 的稳定 JSON 载荷生成 API 私钥签名。 */
  signQueryRequest(access: QueryAccessContext, query: QueryDsl): string {
    const signer = createSign("RSA-SHA256");
    signer.update(stableStringify({ access, query }));
    signer.end();
    return signer.sign(this.signingPem, "base64url");
  }

  /** 返回 Access JWT 有效期，供登录响应告知客户端。 */
  get accessTokenTtlSeconds(): number {
    return this.accessTokenTtl;
  }

  /** 校验 Access JWT 的签名、来源、受众和身份字段。 */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const { payload } = await jwtVerify(token, this.verificationKey, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256"],
    });

    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.org_id !== "string" ||
      typeof payload.authz_version !== "number" ||
      !Number.isInteger(payload.authz_version) ||
      typeof payload.iss !== "string" ||
      (typeof payload.aud !== "string" && !Array.isArray(payload.aud)) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      throw new Error("Access JWT 缺少有效的身份字段");
    }

    return {
      sub: payload.sub,
      sid: payload.sid,
      org_id: payload.org_id,
      authz_version: payload.authz_version,
      iss: payload.iss,
      aud: payload.aud,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}

export { JwtService };
export type { AccessTokenClaims, AccessTokenInput, InternalQueryTokenInput };
