import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

/** DAS 的唯一 JSON 启动配置。该配置必须在连接 DAS 元数据数据库前可用。 */
const dasConfigSchema = z
  .object({
    /** DAS HTTP 服务自身的监听和实例标识配置。 */
    service: z
      .object({
        /** 监听地址必须是明确的主机地址，避免服务意外暴露。 */
        host: z.string().min(1, "service.host 不能为空"),
        /** 端口使用正整数，避免无效的 TCP 监听配置。 */
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
        /** 心跳端点必须是相对路径，防止配置绕过 API Host。 */
        heartbeat_path: z.string().regex(/^\//, "api.heartbeat_path 必须以 / 开头"),
        /** API 签发 JWT 的公钥文件路径；文件内容不进入启动配置。 */
        jwt_verification_public_key_path: z
          .string()
          .min(1, "api.jwt_verification_public_key_path 不能为空"),
      })
      .strict(),
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
            /** 仅开发或受控环境允许信任自签名证书。 */
            trust_server_certificate: z.boolean(),
            /** 连接元数据库的最长等待时间。 */
            connection_timeout_ms: z.number().int().min(100).max(120000),
            /** 单个元数据库请求的最长等待时间。 */
            request_timeout_ms: z.number().int().min(100).max(120000),
            /** 元数据库连接池限制，防止 DAS 自身连接耗尽 SQL Server。 */
            pool: z
              .object({
                /** 连接池最大连接数。 */
                max: z.number().int().min(1).max(100),
                /** 预热的最小连接数，不能超过最大连接数。 */
                min: z.number().int().min(0).max(100),
                /** 空闲连接回收时间。 */
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

export { dasConfigSchema, loadApiVerificationPublicKey, loadDasConfig, parseDasConfig };
export type { DasConfig };
