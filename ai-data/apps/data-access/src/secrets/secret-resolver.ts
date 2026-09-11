import { z } from "zod";

import type { DataSourceConfig, EncryptedDataSourceSecret } from "../metadata/metadata-records";
import { Aes256GcmSecretCipher, type AesGcmEncryptedPayload } from "./aes-256-gcm-secret-cipher";
import type { MasterKeyProvider } from "./local-master-key-store";

/** SQL Server、MySQL、PostgreSQL 与 Oracle 共用的受控服务器登录凭据字段。 */
const databaseSecretFields = {
  /** 业务数据库主机名或 IP 地址。 */
  host: z.string().min(1),
  /** 业务数据库 TCP 端口。 */
  port: z.number().int().min(1).max(65535),
  /** 只读业务数据库登录名。 */
  user: z.string().min(1),
  /** 只读业务数据库登录密码，仅在连接器创建期间驻留内存。 */
  password: z.string().min(1),
};

/** 解密后只允许形成当前五类连接器所需的受控凭据结构。 */
const resolvedDataSourceSecretSchema = z.discriminatedUnion("connectorKind", [
  z
    .object({
      /** 凭据只能交给 SQL Server 连接器。 */
      connectorKind: z.literal("sqlserver"),
      ...databaseSecretFields,
    })
    .strict(),
  z
    .object({
      /** 凭据只能交给 MySQL 连接器。 */
      connectorKind: z.literal("mysql"),
      ...databaseSecretFields,
    })
    .strict(),
  z
    .object({
      /** 凭据只能交给 PostgreSQL 连接器。 */
      connectorKind: z.literal("postgresql"),
      ...databaseSecretFields,
    })
    .strict(),
  z
    .object({
      /** 凭据只能交给 Oracle 连接器。 */
      connectorKind: z.literal("oracle"),
      ...databaseSecretFields,
    })
    .strict(),
  z
    .object({
      /** 凭据只能交给 HTTP API 连接器。 */
      connectorKind: z.literal("http_api"),
      /** 已审核外部 API 的固定根地址。 */
      baseUrl: z.string().url(),
      /** 仅由管理员配置的固定请求头，例如 API Key。 */
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
]);

/** 已解密且已校验的连接器专属数据源凭据。 */
type ResolvedDataSourceSecret = z.infer<typeof resolvedDataSourceSecretSchema>;

/** 数据源密文仓储依赖的最小读取能力。 */
interface DataSourceSecretLookup {
  /** 按密钥引用读取持久化 AES-GCM 密文。 */
  findBySecretRef(secretRef: string): Promise<EncryptedDataSourceSecret | undefined>;
}

/** 数据源管理器依赖的最小凭据解析能力。 */
interface DataSourceSecretResolver {
  /** 将一条已启用数据源配置解析为对应连接器凭据。 */
  resolve(config: DataSourceConfig): Promise<ResolvedDataSourceSecret>;
}

/** 将元数据库中的密文解析为一个连接器可使用的受控连接配置。 */
class SecretResolver implements DataSourceSecretResolver {
  constructor(
    private readonly secretLookup: DataSourceSecretLookup,
    private readonly masterKeyProvider: MasterKeyProvider,
    private readonly cipher: Aes256GcmSecretCipher = new Aes256GcmSecretCipher(),
  ) {}

  /** 解密、校验并确认凭据类型与已启用数据源配置一致。 */
  async resolve(config: DataSourceConfig): Promise<ResolvedDataSourceSecret> {
    const secret = await this.secretLookup.findBySecretRef(config.secretRef);
    if (secret === undefined) {
      throw new Error(`数据源凭据不存在: ${config.sourceId}`);
    }

    const key = await this.masterKeyProvider.getKey(secret.keyId);
    const plaintext = this.decrypt(secret, key);
    const resolved = parseSecretJson(plaintext);

    if (resolved.connectorKind !== config.connectorKind) {
      throw new Error(`数据源凭据类型与连接器类型不一致: ${config.sourceId}`);
    }

    return resolved;
  }

  private decrypt(secret: EncryptedDataSourceSecret, key: Buffer): Buffer {
    try {
      return this.cipher.decrypt(
        {
          encryptedPayload: secret.encryptedPayload,
          metadata: secret.metadata,
        } satisfies AesGcmEncryptedPayload,
        key,
      );
    } catch {
      throw new Error(`数据源凭据无法解密: ${secret.secretRef}`);
    }
  }
}

/** 解析凭据 JSON 时不把原始内容或字段值放入错误消息。 */
function parseSecretJson(plaintext: Buffer): ResolvedDataSourceSecret {
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    throw new Error("数据源凭据内容不是合法 JSON");
  }

  const result = resolvedDataSourceSecretSchema.safeParse(value);
  if (!result.success) {
    throw new Error("数据源凭据内容格式无效");
  }
  return result.data;
}

export { SecretResolver };
export type { DataSourceSecretLookup, DataSourceSecretResolver, ResolvedDataSourceSecret };
