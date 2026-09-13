import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { aesGcmEncryptionMetadataSchema } from "../secrets/aes-gcm-encryption-metadata";
import { dataSourceSecretRowSchema } from "./secret-records";
import { parsePersistedJson } from "./parse-persisted-json";
import type { EncryptedDataSourceSecret } from "../secrets/secret-types";

/** 持久化共享凭据密文；管理服务负责加密写入，SecretResolver 负责读取和解密。 */
class SecretRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 按密钥引用读取 AES-GCM 密文和认证元数据。 */
  async findBySecretRef(secretRef: string): Promise<EncryptedDataSourceSecret | undefined> {
    const result = await this.executor.execute({
      sql: `
        SELECT secret_ref, encryption_algorithm, key_id, encrypted_payload, encryption_metadata_json
        FROM dbo.data_source_secrets
        WHERE secret_ref = @secret_ref;
      `,
      parameters: [{ name: "secret_ref", type: "string", value: secretRef }],
    });
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    const secret = dataSourceSecretRowSchema.parse(row);
    return {
      secretRef: secret.secret_ref,
      keyId: secret.key_id,
      encryptedPayload: secret.encrypted_payload,
      metadata: parsePersistedJson(
        secret.encryption_metadata_json,
        aesGcmEncryptionMetadataSchema,
        "data_source_secrets.encryption_metadata_json",
      ),
    };
  }

  /** 保存一条已加密的共享凭据；同一引用再次保存时更新密文和密钥版本。 */
  async upsert(secret: EncryptedDataSourceSecret): Promise<void> {
    await this.executor.execute({
      sql: `
        UPDATE dbo.data_source_secrets
        SET key_id = @key_id,
          encrypted_payload = @encrypted_payload,
          encryption_metadata_json = @encryption_metadata_json,
          updated_at = GETDATE()
        WHERE secret_ref = @secret_ref;

        IF @@ROWCOUNT = 0
        BEGIN
          INSERT INTO dbo.data_source_secrets (
            secret_ref,
            encryption_algorithm,
            key_id,
            encrypted_payload,
            encryption_metadata_json
          )
          VALUES (
            @secret_ref,
            N'AES-256-GCM',
            @key_id,
            @encrypted_payload,
            @encryption_metadata_json
          );
        END;
      `,
      parameters: [
        { name: "secret_ref", type: "string", value: secret.secretRef },
        { name: "key_id", type: "string", value: secret.keyId },
        { name: "encrypted_payload", type: "binary", value: secret.encryptedPayload },
        {
          name: "encryption_metadata_json",
          type: "string",
          value: JSON.stringify(secret.metadata),
        },
      ],
    });
  }
}

export { SecretRepository };
