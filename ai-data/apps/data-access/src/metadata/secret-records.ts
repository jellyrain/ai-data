import { z } from "zod";

/** 本地密钥库文件名可安全使用的密钥版本标识。 */
const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, "key_id 必须是安全密钥标识");

/** 元数据库中一条 AES-256-GCM 数据源密文记录，仅接受声明字段。 */
const dataSourceSecretRowSchema = z
  .object({
    /** 数据源配置引用的密文标识。 */
    secret_ref: z.string().min(1),
    /** 当前阶段只允许 AES-256-GCM 密文。 */
    encryption_algorithm: z.literal("AES-256-GCM"),
    /** 解密此密文所需的本地主密钥版本。 */
    key_id: keyIdSchema,
    /** SQL Server VARBINARY 读取出的 AES-GCM 密文。 */
    encrypted_payload: z.instanceof(Buffer),
    /** IV 与认证标签的 JSON 持久化内容。 */
    encryption_metadata_json: z.string(),
  })
  .strict();

export { dataSourceSecretRowSchema };
