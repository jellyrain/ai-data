import { z } from "zod";

/** AES-GCM 密文的 IV 与认证标签记录，仅接受声明字段，并校验十六进制长度。 */
const aesGcmEncryptionMetadataSchema = z
  .object({
    /** 每条密文独立生成的 12 字节随机 IV，使用十六进制文本保存。 */
    iv_hex: z.string().regex(/^[0-9a-f]{24}$/i, "iv_hex 必须是 12 字节十六进制文本"),
    /** 解密结束时用于完整性认证的 16 字节标签，以十六进制保存。 */
    auth_tag_hex: z.string().regex(/^[0-9a-f]{32}$/i, "auth_tag_hex 必须是 16 字节十六进制文本"),
  })
  .strict();

export { aesGcmEncryptionMetadataSchema };
