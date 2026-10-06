import { readFileSync } from "node:fs";

import { z } from "zod";
import { memoryTaskConfigSchema } from "./memory-task-config";

import type { MetadataConnectionConfig } from "@ai-data/metadata";

/** API 专属 SQL Server 连接配置；对象各层拒绝未知字段，连接池最小容量不得超过最大容量。 */
const metadataConnectionSchema = z
  .object({
    /** 元数据库主机名或 IP。 */
    server: z.string().min(1, "metadata_sqlserver.server 不能为空"),
    /** SQL Server TCP 端口。 */
    port: z.number().int().min(1).max(65535),
    /** 保存 API 用户、会话与业务配置的数据库名称。 */
    database: z.string().min(1, "metadata_sqlserver.database 不能为空"),
    /** API 访问元数据库的专属登录名。 */
    user: z.string().min(1, "metadata_sqlserver.user 不能为空"),
    /** 元数据库登录密码。 */
    password: z.string().min(1, "metadata_sqlserver.password 不能为空"),
    /** 连接安全、超时与连接池资源限制。 */
    options: z
      .object({
        /** 是否对 SQL Server 连接启用加密。 */
        encrypt: z.boolean(),
        /** 是否信任服务端证书，部署方应按证书配置决定。 */
        trust_server_certificate: z.boolean(),
        /** 建连等待上限，单位毫秒，允许 0.1 秒至 2 分钟。 */
        connection_timeout_ms: z.number().int().min(100).max(120000),
        /** 单次元数据库请求的等待上限，单位毫秒。 */
        request_timeout_ms: z.number().int().min(100).max(120000),
        /** 池容量上限为 100，空闲连接回收范围为 1 秒至 1 小时。 */
        pool: z
          .object({
            /** 连接池最多保留的连接数。 */
            max: z.number().int().min(1).max(100),
            /** 最小保留连接数；0 表示允许连接池完全空闲。 */
            min: z.number().int().min(0).max(100),
            /** 空闲连接回收时间，单位毫秒。 */
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

/** API 启动配置；根对象和嵌套对象均拒绝未声明字段，防止部署配置拼写错误被忽略。 */
const apiConfigSchema = z
  .object({
    /** 运行环境名称，用于日志和默认安全策略。 */
    node_env: z.enum(["development", "test", "production"]),
    /** 省略使用独立后台队列的默认预算。 */
    memory_tasks: memoryTaskConfigSchema.optional(),
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
    /** 服务级分析调度配置；模型和 Agent 的执行预算由组织配置版本提供。 */
    analysis_runtime: z
      .object({
        enabled: z.boolean(),
        /** 相对项目启动工作目录解析，集中保存官方历史、日志及临时文件。 */
        state_directory: z.string().min(1).default("secrets/codex-runtime"),
        /** 公共 Skill 源库，相对路径以启动目录解析；省略使用随包提供的业务 Skill。 */
        skills_directory: z.string().min(1).optional(),
        /** 当前 API 实例最多并行派发的分析运行数。 */
        concurrency: z.number().int().min(1).max(20).default(2),
        /** 持久队列轮询周期，单位毫秒。 */
        poll_ms: z.number().int().min(100).max(30000).default(1000),
      })
      .strict()
      .optional(),
    /** API 自己的元数据库连接配置。 */
    metadata_sqlserver: metadataConnectionSchema,
    /** 获准接入的 DAS 实例；省略时没有实例可注册。版本递增后旧接入凭证失效。 */
    trusted_data_access_services: z
      .array(
        z
          .object({
            service_id: z.string().min(1),
            credential_version: z.number().int().positive(),
            enabled: z.boolean(),
            /** 实例专用随机密钥用于自动领取 JWT；省略时仅支持管理员签发。 */
            registration_secret: z
              .string()
              .min(32)
              .max(256)
              .regex(/^[A-Za-z0-9_-]+$/)
              .optional(),
          })
          .strict(),
      )
      .refine(
        (services) =>
          new Set(services.map((service) => service.service_id)).size === services.length,
        "DAS 实例标识不能重复",
      )
      .optional(),
    /** API 签发和校验访问 JWT 的配置。 */
    jwt: z
      .object({
        /** 面向浏览器的 Access JWT 签发方；内部查询 JWT 使用独立的固定值。 */
        issuer: z.string().min(1, "jwt.issuer 不能为空"),
        /** Access JWT 允许的受众，由 API 验证令牌时匹配。 */
        audience: z.string().min(1, "jwt.audience 不能为空"),
        /** Access JWT 的有效期，单位为秒。 */
        access_token_ttl_seconds: z.number().int().min(60).max(3600),
        /** PKCS#8 私钥 PEM；与公钥同时提供时使用此密钥对，否则进入本地密钥库流程。 */
        signing_private_key_pem: z.string().min(1).optional(),
        /** 与配置私钥配套的 SubjectPublicKeyInfo 公钥 PEM。 */
        verification_public_key_pem: z.string().min(1).optional(),
        /** 本地密钥目录；启动入口未收到此项时使用应用 secrets 目录。 */
        key_directory: z.string().min(1).optional(),
      })
      .strict(),
    /** 首次部署的管理员资料；省略时跳过默认账号初始化。 */
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

/** 用 Number 转换环境变量文本并要求整数，取值范围由配置 Schema 校验。 */
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

/** 按环境变量构造配置的独立入口；当前服务启动入口读取 JSON 文件。 */
function parseApiEnvironment(env: NodeJS.ProcessEnv): ApiConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} 不能为空`);
    return value;
  };

  return apiConfigSchema.parse({
    // 环境变量入口默认监听本机 3000；连接启用加密，池容量为 0–10。
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

/** 读取并校验启动入口指定的 JSON 文件；文件与配置错误在启动阶段向上传播。 */
function loadApiConfig(path: string): ApiConfig {
  return parseApiConfig(readFileSync(path, "utf8"));
}

export { apiConfigSchema, loadApiConfig, parseApiConfig, parseApiEnvironment };
export type { ApiConfig };
