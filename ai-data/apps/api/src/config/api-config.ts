import { readFileSync } from "node:fs";

import { z } from "zod";

import type { MetadataConnectionConfig } from "@ai-data/metadata";

/** API 元数据库 SQL Server 连接配置的校验规则。 */
const metadataConnectionSchema = z
  .object({
    server: z.string().min(1, "metadata_sqlserver.server 不能为空"),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1, "metadata_sqlserver.database 不能为空"),
    user: z.string().min(1, "metadata_sqlserver.user 不能为空"),
    password: z.string().min(1, "metadata_sqlserver.password 不能为空"),
    options: z
      .object({
        encrypt: z.boolean(),
        trust_server_certificate: z.boolean(),
        connection_timeout_ms: z.number().int().min(100).max(120000),
        request_timeout_ms: z.number().int().min(100).max(120000),
        pool: z
          .object({
            max: z.number().int().min(1).max(100),
            min: z.number().int().min(0).max(100),
            idle_timeout_ms: z.number().int().min(1000).max(3600000),
          })
          .strict()
          .refine((pool) => pool.min <= pool.max, {
            message: "metadata_sqlserver.options.pool.min 不能大于 max",
          }),
      })
      .strict(),
  })
  .strict();

/** API 启动所需的服务和元数据库配置。 */
const apiConfigSchema = z
  .object({
    /** 运行环境名称，用于日志和默认安全策略。 */
    node_env: z.enum(["development", "test", "production"]),
    /** API HTTP 服务配置。 */
    service: z
      .object({
        /** API 监听地址。 */
        host: z.string().min(1, "service.host 不能为空"),
        /** API 监听端口。 */
        port: z.number().int().min(1).max(65535),
        /** 服务实例标识。 */
        service_id: z.string().min(1, "service.service_id 不能为空"),
        /** 服务版本。 */
        service_version: z.string().min(1, "service.service_version 不能为空"),
      })
      .strict(),
    /** API 自己的元数据库连接配置。 */
    metadata_sqlserver: metadataConnectionSchema,
    /** API 签发和校验访问 JWT 的配置。 */
    jwt: z
      .object({
        /** JWT 签发方，API 和内部服务使用它校验令牌来源。 */
        issuer: z.string().min(1, "jwt.issuer 不能为空"),
        /** JWT 受众，限制令牌只能用于指定服务。 */
        audience: z.string().min(1, "jwt.audience 不能为空"),
        /** Access JWT 的有效期，单位为秒。 */
        access_token_ttl_seconds: z.number().int().min(60).max(3600),
        /** 签发 JWT 的 PKCS#8 私钥 PEM。 */
        signing_private_key_pem: z.string().min(1).optional(),
        /** 校验 JWT 的 SubjectPublicKeyInfo 公钥 PEM。 */
        verification_public_key_pem: z.string().min(1).optional(),
        /** API 本地 JWT 密钥文件目录。 */
        key_directory: z.string().min(1).optional(),
      })
      .strict(),
    bootstrap_admin: z
      .object({
        /** 默认组织主键。 */
        organization_id: z.string().min(1),
        /** 默认组织编码。 */
        organization_code: z.string().min(1),
        /** 默认组织名称。 */
        organization_name: z.string().min(1),
        /** 首个管理员登录名。 */
        username: z.string().min(1),
        /** 首个管理员展示名称。 */
        display_name: z.string().min(1),
        /** 部署时提供的初始密码，启动后只保存派生哈希。 */
        password: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 经过 Schema 校验后的 API 启动配置。 */
type ApiConfig = z.infer<typeof apiConfigSchema>;

/** 将环境变量中的严格布尔文本转换为布尔值。 */
function parseBoolean(value: string, fieldName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${fieldName} 必须是 true 或 false`);
}

/** 将环境变量中的十进制文本转换为整数。 */
function parseInteger(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${fieldName} 必须是整数`);
  return parsed;
}

/** 将 JSON 文本解析并校验为 API 启动配置。 */
function parseApiConfig(content: string): ApiConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`API 配置文件不是合法 JSON: ${message}`, { cause: error });
  }

  return apiConfigSchema.parse(parsed);
}

/** 从环境变量构造并校验 API 配置。 */
function parseApiEnvironment(env: NodeJS.ProcessEnv): ApiConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} 不能为空`);
    return value;
  };

  return apiConfigSchema.parse({
    node_env: env.NODE_ENV ?? "development",
    service: {
      host: env.API_HOST ?? "127.0.0.1",
      port: parseInteger(env.API_PORT ?? "3000", "API_PORT"),
      service_id: env.API_SERVICE_ID ?? "ai-bi-api",
      service_version: env.API_SERVICE_VERSION ?? "1.0.0",
    },
    metadata_sqlserver: {
      server: required("META_SQLSERVER_SERVER"),
      port: parseInteger(env.META_SQLSERVER_PORT ?? "1433", "META_SQLSERVER_PORT"),
      database: required("META_SQLSERVER_DATABASE"),
      user: required("META_SQLSERVER_USER"),
      password: required("META_SQLSERVER_PASSWORD"),
      options: {
        encrypt: parseBoolean(env.META_SQLSERVER_ENCRYPT ?? "true", "META_SQLSERVER_ENCRYPT"),
        trust_server_certificate: parseBoolean(
          env.META_SQLSERVER_TRUST_SERVER_CERTIFICATE ?? "false",
          "META_SQLSERVER_TRUST_SERVER_CERTIFICATE",
        ),
        connection_timeout_ms: parseInteger(
          env.META_SQLSERVER_CONNECTION_TIMEOUT_MS ?? "5000",
          "META_SQLSERVER_CONNECTION_TIMEOUT_MS",
        ),
        request_timeout_ms: parseInteger(
          env.META_SQLSERVER_REQUEST_TIMEOUT_MS ?? "10000",
          "META_SQLSERVER_REQUEST_TIMEOUT_MS",
        ),
        pool: {
          max: parseInteger(env.META_SQLSERVER_POOL_MAX ?? "10", "META_SQLSERVER_POOL_MAX"),
          min: parseInteger(env.META_SQLSERVER_POOL_MIN ?? "0", "META_SQLSERVER_POOL_MIN"),
          idle_timeout_ms: parseInteger(
            env.META_SQLSERVER_POOL_IDLE_TIMEOUT_MS ?? "30000",
            "META_SQLSERVER_POOL_IDLE_TIMEOUT_MS",
          ),
        },
      },
    } satisfies MetadataConnectionConfig,
    jwt: {
      issuer: env.API_JWT_ISSUER ?? "ai-data-api",
      audience: env.API_JWT_AUDIENCE ?? "ai-data-api",
      access_token_ttl_seconds: parseInteger(
        env.API_JWT_ACCESS_TOKEN_TTL_SECONDS ?? "900",
        "API_JWT_ACCESS_TOKEN_TTL_SECONDS",
      ),
      ...(env.API_JWT_SIGNING_PRIVATE_KEY_PEM
        ? { signing_private_key_pem: env.API_JWT_SIGNING_PRIVATE_KEY_PEM }
        : {}),
      ...(env.API_JWT_VERIFICATION_PUBLIC_KEY_PEM
        ? { verification_public_key_pem: env.API_JWT_VERIFICATION_PUBLIC_KEY_PEM }
        : {}),
      ...(env.API_JWT_KEY_DIRECTORY ? { key_directory: env.API_JWT_KEY_DIRECTORY } : {}),
    },
  });
}

/** 从指定 JSON 文件加载 API 配置，保留给测试和文件化部署使用。 */
function loadApiConfig(path: string): ApiConfig {
  return parseApiConfig(readFileSync(path, "utf8"));
}

export { apiConfigSchema, loadApiConfig, parseApiConfig, parseApiEnvironment };
export type { ApiConfig };
