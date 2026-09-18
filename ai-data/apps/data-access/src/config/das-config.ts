import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

/** DAS 启动 JSON 的结构合同，各层对象均拒绝未知字段；连接元数据库前完成校验。 */
const dasConfigSchema = z
  .object({
    /** DAS HTTP 服务自身的监听和实例标识配置。 */
    service: z
      .object({
        /** HTTP 监听地址，由部署方决定网络可达范围；此处仅检查非空。 */
        host: z.string().min(1, "service.host 不能为空"),
        /** HTTP 监听端口，限定在可配置的 TCP 端口范围。 */
        port: z.number().int().min(1).max(65535),
        /** 实例标识用于 API 心跳和 DAS 审计关联。 */
        service_id: z.string().min(1, "service.service_id 不能为空"),
        /** 服务版本用于运行诊断和发布追踪。 */
        service_version: z.string().min(1, "service.service_version 不能为空"),
      })
      .strict(),
    /** API 对接和 JWT 验签启动配置。 */
    api: z
      .object({
        /** API 内部根地址，供心跳和后续受控回调使用。 */
        base_url: z.url("api.base_url 必须是完整 URL"),
        /** API 内部路径，限制字符以保证凭据始终发送到配置的 API 主机。 */
        heartbeat_path: z
          .string()
          .regex(/^\/[A-Za-z0-9/_-]+$/, "api.heartbeat_path 必须是 API 内部路径")
          .refine((path) => !path.startsWith("//")),
        /** 注册端点；省略时使用 API 的标准内部注册路径。 */
        registration_path: z
          .string()
          .regex(/^\/[A-Za-z0-9/_-]+$/)
          .refine((path) => !path.startsWith("//"))
          .optional(),
        /** API 签发的实例接入凭证文件，相对路径以配置目录为基准。 */
        registration_credential_path: z.string().min(1),
        /** API 验签公钥文件路径；相对路径以启动配置所在目录为基准。 */
        jwt_verification_public_key_path: z
          .string()
          .min(1, "api.jwt_verification_public_key_path 不能为空"),
      })
      .strict(),
    /** 按 source_id 配置业务 SQL Server 链路；省略的源默认加密并验证服务器证书。 */
    sqlserver_transports: z
      .record(
        z.string().min(1, "source_id 不能为空").max(128),
        z
          .object({
            /** 当前业务数据源是否启用传输加密。 */
            encrypt: z.boolean(),
            /** 当前业务数据源是否信任其服务器证书，由部署方按证书配置选择。 */
            trust_server_certificate: z.boolean(),
          })
          .strict(),
      )
      .optional(),
    /** DAS 自己的 SQL Server 元数据和审计数据库连接配置。 */
    metadata_sqlserver: z
      .object({
        /** SQL Server 主机名或 IP 地址。 */
        server: z.string().min(1, "metadata_sqlserver.server 不能为空"),
        /** SQL Server TCP 端口使用有效范围。 */
        port: z.number().int().min(1).max(65535),
        /** DAS 元数据数据库名。 */
        database: z.string().min(1, "metadata_sqlserver.database 不能为空"),
        /** DAS 元数据库专用登录名。 */
        user: z.string().min(1, "metadata_sqlserver.user 不能为空"),
        /** 启动配置允许保存 DAS 元数据库密码明文，由部署文件权限保护。 */
        password: z.string().min(1, "metadata_sqlserver.password 不能为空"),
        /** SQL Server 驱动连接、请求和连接池限制。 */
        options: z
          .object({
            /** 是否要求 SQL Server 链路加密。 */
            encrypt: z.boolean(),
            /** 是否跳过服务器证书的信任校验，由部署方按证书配置选择。 */
            trust_server_certificate: z.boolean(),
            /** 连接等待上限，单位毫秒；限制在 100 毫秒至 120 秒之间。 */
            connection_timeout_ms: z.number().int().min(100).max(120000),
            /** 单次元数据请求超时，单位毫秒；最多等待 120 秒以限制连接占用。 */
            request_timeout_ms: z.number().int().min(100).max(120000),
            /** 元数据库连接池限制，防止 DAS 自身连接耗尽 SQL Server。 */
            pool: z
              .object({
                /** 元数据库连接池容量，最多 100 个连接。 */
                max: z.number().int().min(1).max(100),
                /** 预热的最小连接数，不能超过最大连接数。 */
                min: z.number().int().min(0).max(100),
                /** 空闲回收等待时间，单位毫秒，允许 1 秒至 1 小时。 */
                idle_timeout_ms: z.number().int().min(1000).max(3600000),
              })
              .strict()
              .refine((pool) => pool.min <= pool.max, {
                message: "metadata_sqlserver.options.pool.min 不能大于 max",
              }),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** 经过 Schema 校验后的 DAS 启动配置类型。 */
type DasConfig = z.infer<typeof dasConfigSchema>;

/** 将 JSON 文本解析并校验为 DAS 启动配置，供测试和文件加载复用。 */
function parseDasConfig(content: string): DasConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DAS 配置文件不是合法 JSON: ${message}`, { cause: error });
  }

  return dasConfigSchema.parse(parsed);
}

/** 从指定 JSON 文件加载并校验 DAS 唯一启动配置。 */
function loadDasConfig(path: string): DasConfig {
  return parseDasConfig(readFileSync(path, "utf8"));
}

/** 读取 API 公钥文件，供 DAS JWT 验签器启动时导入。 */
function loadApiVerificationPublicKey(config: DasConfig, baseDirectory = process.cwd()): string {
  return readFileSync(resolve(baseDirectory, config.api.jwt_verification_public_key_path), "utf8");
}

/** 启动及重新注册时读取当前接入凭证，文件内容不进入日志。 */
function loadRegistrationCredential(config: DasConfig, baseDirectory = process.cwd()): string {
  const credential = readFileSync(
    resolve(baseDirectory, config.api.registration_credential_path),
    "utf8",
  ).trim();
  if (!credential) throw new Error("DAS 接入凭证文件为空");
  return credential;
}

export {
  dasConfigSchema,
  loadApiVerificationPublicKey,
  loadDasConfig,
  parseDasConfig,
  loadRegistrationCredential,
};
export type { DasConfig };
