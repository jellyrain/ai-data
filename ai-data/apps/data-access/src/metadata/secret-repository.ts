import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { aesGcmEncryptionMetadataSchema } from "../secrets/aes-gcm-encryption-metadata";
import { dataSourceSecretRowSchema } from "./secret-records";
import { parsePersistedJson } from "./parse-persisted-json";
import type { EncryptedDataSourceSecret } from "../secrets/secret-types";

/** 持久化共享凭据密文；管理服务负责加密写入，SecretResolver 负责读取和解密。 */
class SecretRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 原子比较旧密文；缺失记录以键范围锁保护首次插入，返回是否确实提交。 */
  async replace(
    secret: EncryptedDataSourceSecret,
    previous: EncryptedDataSourceSecret | undefined,
  ): Promise<boolean> {
    const result = await this.executor.execute<{ changed: number }>({
      sql: previous
        ? `
        UPDATE dbo.data_source_secrets SET key_id = @key_id,
          encrypted_payload = @encrypted_payload, encryption_metadata_json = @metadata, updated_at = GETDATE()
        WHERE secret_ref = @secret_ref AND key_id = @previous_key AND encrypted_payload = @previous_payload;
        SELECT @@ROWCOUNT AS changed;
      `
        : `
        INSERT INTO dbo.data_source_secrets (secret_ref, encryption_algorithm, key_id, encrypted_payload, encryption_metadata_json)
        SELECT @secret_ref, N'AES-256-GCM', @key_id, @encrypted_payload, @metadata
        WHERE NOT EXISTS (SELECT 1 FROM dbo.data_source_secrets WITH (UPDLOCK, HOLDLOCK) WHERE secret_ref = @secret_ref);
        SELECT @@ROWCOUNT AS changed;
      `,
      parameters: [
        { name: "secret_ref", type: "string", value: secret.secretRef },
        { name: "key_id", type: "string", value: secret.keyId },
        { name: "encrypted_payload", type: "binary", value: secret.encryptedPayload },
        { name: "metadata", type: "string", value: JSON.stringify(secret.metadata) },
        ...(previous
          ? [
              { name: "previous_key", type: "string" as const, value: previous.keyId },
              {
                name: "previous_payload",
                type: "binary" as const,
                value: previous.encryptedPayload,
              },
            ]
          : []),
      ],
    });
    return result.rows[0]?.changed === 1;
  }

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
