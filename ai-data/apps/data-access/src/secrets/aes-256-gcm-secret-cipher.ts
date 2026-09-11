import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-GCM 解密所需的随机 IV 和认证标签。 */
interface AesGcmEncryptionMetadata {
  /** 12 字节随机初始化向量的十六进制文本。 */
  iv_hex: string;
  /** 16 字节 GCM 认证标签的十六进制文本。 */
  auth_tag_hex: string;
}

/** 可持久化到元数据库的一段 AES-GCM 密文。 */
interface AesGcmEncryptedPayload {
  /** 不包含认证标签的 AES-GCM 密文。 */
  encryptedPayload: Buffer;
  /** 解密时需要的 IV 和认证标签。 */
  metadata: AesGcmEncryptionMetadata;
}

/** 使用 DAS 本地主密钥加密和认证外部数据源凭据。 */
class Aes256GcmSecretCipher {
  /** 使用每条密文独立的随机 IV 加密明文。 */
  encrypt(plaintext: Buffer, key: Buffer): AesGcmEncryptedPayload {
    assertMasterKey(key);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encryptedPayload = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      encryptedPayload,
      metadata: {
        iv_hex: iv.toString("hex"),
        auth_tag_hex: cipher.getAuthTag().toString("hex"),
      },
    };
  }

  /** 验证认证标签后恢复完整明文，密文遭篡改时不返回部分结果。 */
  decrypt(encrypted: AesGcmEncryptedPayload, key: Buffer): Buffer {
    assertMasterKey(key);
    const iv = Buffer.from(encrypted.metadata.iv_hex, "hex");
    const authTag = Buffer.from(encrypted.metadata.auth_tag_hex, "hex");
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error("AES-256-GCM 密文元数据无效");
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted.encryptedPayload), decipher.final()]);
    } catch {
      throw new Error("AES-256-GCM 密文无法通过认证");
    }
  }
}

/** AES-256-GCM 只能使用 32 字节主密钥。 */
function assertMasterKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("AES-256-GCM 主密钥必须为 32 字节");
  }
}

export { Aes256GcmSecretCipher };
export type { AesGcmEncryptedPayload, AesGcmEncryptionMetadata };
