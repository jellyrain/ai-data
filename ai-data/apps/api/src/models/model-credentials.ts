import { modelConfigurationInputSchema } from "@ai-data/contracts";
import { z } from "zod";

/** 解密后的模型认证仅接受管理接口定义的凭据字段，省略表示该版本不用此项。 */
const modelCredentialsSchema = modelConfigurationInputSchema.pick({ api_key: true, headers: true });

/** 仓储边界校验 AES-GCM 密文、主密钥版本和认证元数据，拒绝未知字段。 */
const encryptedModelCredentialsSchema = z
  .object({
    /** 本地主密钥库用于定位解密密钥的安全版本标识。 */
    keyId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(128),
    /** 加密后的完整认证 JSON，SQL 使用 VARBINARY 保存。 */
    encryptedPayload: z.instanceof(Buffer).refine((value) => value.length > 0),
    /** 与 DAS 相同的 12 字节随机 IV 和 16 字节认证标签。 */
    metadata: z
      .object({
        iv_hex: z.string().regex(/^[0-9a-f]{24}$/i),
        auth_tag_hex: z.string().regex(/^[0-9a-f]{32}$/i),
      })
      .strict(),
  })
  .strict();

export { modelCredentialsSchema, encryptedModelCredentialsSchema };
