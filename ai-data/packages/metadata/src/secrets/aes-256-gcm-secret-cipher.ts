import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AesGcmEncryptedPayload } from "./secret-types";

/** 使用本地主密钥加密和认证元数据库中的服务凭据，供 API 与 DAS 共用。 */
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

  /** 完成解密及标签认证后才返回完整明文；认证失败时抛出统一错误。 */
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
      // final 执行认证检查；在它成功前不向调用方返回 update 产生的中间明文。
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
