import { Aes256GcmSecretCipher, type ActiveMasterKeyProvider } from "@ai-data/metadata/secrets";
import { ApplicationError } from "../errors/application-error";
import { encryptedModelCredentialsSchema, modelCredentialsSchema } from "./model-credentials";
import type { EncryptedModelCredentials, ModelCredentials } from "./model-types";

/** 复用共享加密器和主密钥库，认证原文仅在发布加密与运行解密时使用。 */
class ModelCredentialCipher {
  private readonly cipher = new Aes256GcmSecretCipher();
  constructor(private readonly keys: ActiveMasterKeyProvider) {}

  async encrypt(credentials: ModelCredentials): Promise<EncryptedModelCredentials> {
    const value = modelCredentialsSchema.parse(credentials);
    try {
      const key = await this.keys.getActiveKey();
      return {
        keyId: key.keyId,
        ...this.cipher.encrypt(Buffer.from(JSON.stringify(value)), key.value),
      };
    } catch {
      throw new ApplicationError("INTERNAL_ERROR", "模型认证无法加密");
    }
  }

  async decrypt(encrypted: EncryptedModelCredentials): Promise<ModelCredentials> {
    try {
      const record = encryptedModelCredentialsSchema.parse(encrypted);
      const key = await this.keys.getKey(record.keyId);
      const plaintext = this.cipher.decrypt(record, key);
      return modelCredentialsSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      // 解析异常可能含原文片段，统一错误避免凭据进入响应或日志。
      throw new ApplicationError("INTERNAL_ERROR", "模型认证无法解密");
    }
  }
}

export { ModelCredentialCipher };
