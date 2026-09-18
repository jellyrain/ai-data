import { createHash, createSign } from "node:crypto";
import dayjs from "dayjs";
import { errors, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { stableStringify, type QueryAccessContext, type QueryDsl } from "@ai-data/contracts";

import type { ApiConfig } from "../config/api-config";
import { LocalJwtKeyStore } from "./local-jwt-key-store";
import { ApplicationError } from "../errors/application-error";

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
  /** 发起查询的本地用户主键。 */
  userId: string;
  /** 用户所属组织，用于 DAS 查询审计关联。 */
  organizationId: string;
  /** 当前查询所属分析运行主键。 */
  analysisRunId: string;
  /** API 生成查询访问上下文时采用的策略版本。 */
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
    private readonly serviceId: string,
  ) {}

  /** 配置同时提供公私钥时直接导入，否则读取本地密钥库；解析在启动阶段完成。 */
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
      config.service.service_id,
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

  /** 为当前查询签发有效期 60 秒的内部 JWT，使用独立于 Access JWT 的固定来源和受众。 */
  async signInternalQueryToken(input: InternalQueryTokenInput): Promise<string> {
    const issuedAt = dayjs().unix();
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
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setJti(crypto.randomUUID())
      .setExpirationTime(dayjs.unix(issuedAt).add(60, "second").unix())
      .sign(this.signingKey);
  }

  /** 为目录和管理请求签发 60 秒令牌，绑定目标实例、用途和请求内容。 */
  async signServiceRequest(
    serviceId: string,
    purpose: "das_catalog" | "das_management",
    method: string,
    path: string,
    body: unknown,
  ): Promise<string> {
    const issuedAt = dayjs().unix();
    const requestHash = createHash("sha256")
      .update(stableStringify({ method, path, body: body ?? null }))
      .digest("base64url");
    return new SignJWT({ token_use: purpose, request_hash: requestHash })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(INTERNAL_QUERY_ISSUER)
      .setAudience(`ai-data-das:${serviceId}`)
      .setSubject(this.serviceId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(dayjs.unix(issuedAt).add(60, "second").unix())
      .setJti(crypto.randomUUID())
      .sign(this.signingKey);
  }

  /** 为已批准实例生成接入凭证，其生命周期由服务启用状态和凭证版本控制。 */
  async signRegistrationCredential(serviceId: string, credentialVersion: number): Promise<string> {
    const issuedAt = dayjs().unix();
    return new SignJWT({ token_use: "das_registration", credential_version: credentialVersion })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(INTERNAL_QUERY_ISSUER)
      .setAudience(`ai-data-api:${this.serviceId}:registration`)
      .setSubject(serviceId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setJti(crypto.randomUUID())
      .sign(this.signingKey);
  }

  /** 仅注册时验证实例接入签名；配置版本和启用状态由注册服务检查。 */
  async verifyRegistrationCredential(token: string, serviceId: string): Promise<number> {
    try {
      const { payload } = await jwtVerify(token, this.verificationKey, {
        issuer: INTERNAL_QUERY_ISSUER,
        audience: `ai-data-api:${this.serviceId}:registration`,
        subject: serviceId,
        algorithms: ["RS256"],
        requiredClaims: ["iat", "nbf", "jti", "token_use", "credential_version"],
      });
      if (
        payload.token_use !== "das_registration" ||
        typeof payload.jti !== "string" ||
        !payload.jti.trim() ||
        typeof payload.iat !== "number" ||
        payload.iat > dayjs().unix() ||
        typeof payload.credential_version !== "number" ||
        !Number.isInteger(payload.credential_version) ||
        payload.credential_version <= 0
      )
        throw new Error("DAS 接入凭证字段无效");
      return payload.credential_version;
    } catch {
      throw new ApplicationError("AUTHENTICATION_FAILED", "DAS 接入凭证无效");
    }
  }

  /** 对 access 与最终 query 的稳定 JSON 生成独立签名，使 DAS 能发现请求内容被修改。 */
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
    }).catch((cause: unknown) => {
      // 只转换令牌内容和签名校验失败，密钥设施或编程异常继续交给内部错误出口。
      if (
        cause instanceof errors.JWTInvalid ||
        cause instanceof errors.JWSInvalid ||
        cause instanceof errors.JWSSignatureVerificationFailed ||
        cause instanceof errors.JWTExpired ||
        cause instanceof errors.JWTClaimValidationFailed ||
        cause instanceof errors.JOSEAlgNotAllowed
      )
        throw new ApplicationError("AUTHENTICATION_FAILED", "登录令牌无效或已过期", { cause });
      throw cause;
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
      throw new ApplicationError("AUTHENTICATION_FAILED", "登录令牌缺少有效的身份字段");
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
