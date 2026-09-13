import type { z } from "zod";

import type { aesGcmEncryptionMetadataSchema } from "./aes-gcm-encryption-metadata";

/** 解密器可直接消费的一条加密数据源凭据。 */
type EncryptedDataSourceSecret = {
  /** 数据源引用的密文标识。 */
  secretRef: string;
  /** 解密所需的本地主密钥版本。 */
  keyId: string;
  /** 已加密的业务连接配置。 */
  encryptedPayload: Buffer;
  /** 解密时校验的 IV 与认证标签。 */
  metadata: z.infer<typeof aesGcmEncryptionMetadataSchema>;
};

export type { EncryptedDataSourceSecret };
