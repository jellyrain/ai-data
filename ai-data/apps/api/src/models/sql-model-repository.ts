import { modelConfigurationSchema, type ModelConfiguration } from "@ai-data/contracts";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { ModelRepository, StoredModel } from "./model-types";
import { encryptedModelCredentialsSchema } from "./model-credentials";

/** SQL 模型版本记录；启用状态来自当前模型行。 */
const rowSchema = z
  .object({
    definition_json: z.string(),
    key_id: encryptedModelCredentialsSchema.shape.keyId,
    encrypted_payload: encryptedModelCredentialsSchema.shape.encryptedPayload,
    encryption_metadata_json: z.string(),
    enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]),
  })
  .strict();
function mapRow(value: unknown): StoredModel {
  return parseStoredRecord(() => {
    const row = rowSchema.parse(value);
    return {
      configuration: modelConfigurationSchema.parse({
        ...JSON.parse(row.definition_json),
        enabled: Boolean(row.enabled),
      }),
      credentials: encryptedModelCredentialsSchema.parse({
        keyId: row.key_id,
        encryptedPayload: row.encrypted_payload,
        metadata: JSON.parse(row.encryption_metadata_json),
      }),
    };
  });
}
/** 先锁模型再检查版本，保证不同进程的连续发布不会覆盖旧版本。 */
class SqlModelRepository implements ModelRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async publish(organizationId: string, stored: StoredModel): Promise<ModelConfiguration> {
    return this.database.transaction(async (executor) => {
      const definition = modelConfigurationSchema.parse(stored.configuration);
      const credentials = encryptedModelCredentialsSchema.parse(stored.credentials);
      const parameters = [
        { name: "org", type: "string" as const, value: organizationId },
        { name: "id", type: "string" as const, value: definition.model_id },
      ];
      const current = await executor.execute({
        sql: "SELECT enabled FROM dbo.model_configurations WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND model_id=@id",
        parameters,
      });
      const versions = await executor.execute({
        sql: "SELECT COALESCE(MAX(version),0) AS version FROM dbo.model_configuration_versions WHERE organization_id=@org AND model_id=@id",
        parameters,
      });
      if (definition.version !== Number(versions.rows[0]?.version ?? 0) + 1)
        throw new ApplicationError("CONFLICT", "模型版本必须顺序递增，已发布版本不可改写");
      if (!current.rows.length)
        await executor.execute({
          sql: "INSERT INTO dbo.model_configurations(organization_id,model_id,enabled) VALUES(@org,@id,1)",
          parameters,
        });
      const record = {
        ...definition,
        enabled: current.rows.length ? Boolean(current.rows[0].enabled) : true,
      };
      await executor.execute({
        sql: "INSERT INTO dbo.model_configuration_versions(organization_id,model_id,version,definition_json,key_id,encrypted_payload,encryption_metadata_json) VALUES(@org,@id,@version,@json,@key,@payload,@metadata)",
        parameters: [
          ...parameters,
          { name: "version", type: "integer", value: definition.version },
          { name: "json", type: "string", value: JSON.stringify(record) },
          { name: "key", type: "string", value: credentials.keyId },
          { name: "payload", type: "binary", value: credentials.encryptedPayload },
          { name: "metadata", type: "string", value: JSON.stringify(credentials.metadata) },
        ],
      });
      return record;
    });
  }
  async find(
    organizationId: string,
    modelId: string,
    version?: number,
  ): Promise<StoredModel | null> {
    const result = await this.database.execute({
      sql: "SELECT TOP (1) v.definition_json,v.key_id,v.encrypted_payload,v.encryption_metadata_json,m.enabled FROM dbo.model_configuration_versions v JOIN dbo.model_configurations m ON m.organization_id=v.organization_id AND m.model_id=v.model_id WHERE v.organization_id=@org AND v.model_id=@id AND (@version IS NULL OR v.version=@version) ORDER BY v.version DESC",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: modelId },
        { name: "version", type: "integer", value: version ?? null },
      ],
    });
    return result.rows.length ? mapRow(result.rows[0]) : null;
  }
  async list(organizationId: string): Promise<ModelConfiguration[]> {
    const result = await this.database.execute({
      sql: "SELECT v.definition_json,v.key_id,v.encrypted_payload,v.encryption_metadata_json,m.enabled FROM dbo.model_configurations m CROSS APPLY (SELECT TOP (1) definition_json,key_id,encrypted_payload,encryption_metadata_json FROM dbo.model_configuration_versions WHERE organization_id=m.organization_id AND model_id=m.model_id ORDER BY version DESC) v WHERE m.organization_id=@org ORDER BY m.model_id",
      parameters: [{ name: "org", type: "string", value: organizationId }],
    });
    return result.rows.map((row) => mapRow(row).configuration);
  }
  async setEnabled(organizationId: string, modelId: string, enabled: boolean): Promise<boolean> {
    const result = await this.database.execute({
      sql: "UPDATE dbo.model_configurations SET enabled=@enabled WHERE organization_id=@org AND model_id=@id; SELECT @@ROWCOUNT AS changed",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: modelId },
        { name: "enabled", type: "boolean", value: enabled },
      ],
    });
    return Number(result.rows[0]?.changed) === 1;
  }
}

export { SqlModelRepository };
