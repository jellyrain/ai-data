import { z } from "zod";
import { memorySourceSchema } from "@ai-data/contracts";
import type {
  MetadataParameter,
  MetadataQueryExecutor,
  MetadataTransactionalExecutor,
} from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import {
  preferenceAuditSchema,
  preferenceJsonRowSchema,
  preferenceOperationRowSchema,
  preferenceOperationSchema,
  preferenceRecordSchema,
  preferenceRowSchema,
  preferenceConfirmationRecordSchema,
  preferenceSourceRecordSchema,
  preferenceSourceRowSchema,
  preferenceOperationResultSchema,
} from "./preference-records";
import type {
  PreferenceRecord,
  PreferenceRepository,
  PreferenceTransaction,
  PreferenceConfirmationRecord,
} from "./preference-types";

function accountParameters(context: AuthContext): MetadataParameter[] {
  return [
    { name: "org", type: "string", value: context.organizationId },
    { name: "user", type: "string", value: context.userId },
  ];
}
function parameter(name: string, value: string): MetadataParameter {
  return { name, type: "string", value };
}
function assertAccount(
  context: AuthContext,
  record: { organization_id: string; user_id: string },
): void {
  if (record.organization_id !== context.organizationId || record.user_id !== context.userId)
    throw new ApplicationError("INTERNAL_ERROR", "个人记忆持久化归属不一致");
}
/** 同时核对 JSON 与独立索引列，发现损坏时不能将其当作其他账号内容返回。 */
function parsePreferenceRow(context: AuthContext, raw: unknown): PreferenceRecord {
  return parseStoredRecord(() => {
    const row = preferenceRowSchema.parse(raw);
    const record = preferenceRecordSchema.parse(JSON.parse(row.preference_json));
    assertAccount(context, row);
    assertAccount(context, record);
    if (row.version !== record.version || row.preference_key !== record.key)
      throw new Error("个人偏好版本或键不一致");
    return record;
  });
}

/** SQL 事务按账号加更新锁，所有键、确认和幂等操作遵循相同锁顺序。 */
class SqlPreferenceRepository implements PreferenceRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async list(context: AuthContext): Promise<PreferenceRecord[]> {
    const result = await this.database.execute({
      sql: "SELECT TOP (200) organization_id,user_id,preference_key,version,preference_json FROM dbo.user_preferences WHERE organization_id=@org AND user_id=@user AND JSON_VALUE(preference_json,'$.deleted_at') IS NULL ORDER BY preference_key",
      parameters: accountParameters(context),
    });
    return result.rows.map((row) => parsePreferenceRow(context, row));
  }
  async find(context: AuthContext, key: string): Promise<PreferenceRecord | null> {
    return this.findWith(this.database, context, key);
  }
  async listPendingConfirmations(context: AuthContext): Promise<PreferenceConfirmationRecord[]> {
    const result = await this.database.execute({
      sql: "SELECT TOP (200) c.record_json FROM dbo.preference_confirmations c JOIN dbo.user_preferences p ON p.organization_id=c.organization_id AND p.user_id=c.user_id AND p.preference_key=JSON_VALUE(c.record_json,'$.proposed.key') AND p.version=TRY_CONVERT(INT,JSON_VALUE(c.record_json,'$.expected_version')) WHERE c.organization_id=@org AND c.user_id=@user AND JSON_VALUE(c.record_json,'$.status')='pending' AND JSON_VALUE(p.preference_json,'$.deleted_at') IS NULL ORDER BY JSON_VALUE(c.record_json,'$.created_at'),c.confirmation_id",
      parameters: accountParameters(context),
    });
    return result.rows.map((raw) =>
      parseStoredRecord(() => {
        const row = preferenceJsonRowSchema.parse(raw);
        const record = preferenceConfirmationRecordSchema.parse(JSON.parse(row.record_json));
        assertAccount(context, record);
        return record;
      }),
    );
  }
  private async findWith(
    executor: MetadataQueryExecutor,
    context: AuthContext,
    key: string,
  ): Promise<PreferenceRecord | null> {
    const result = await executor.execute({
      sql: "SELECT organization_id,user_id,preference_key,version,preference_json FROM dbo.user_preferences WHERE organization_id=@org AND user_id=@user AND preference_key=@key",
      parameters: [...accountParameters(context), parameter("key", key)],
    });
    return result.rows[0] ? parsePreferenceRow(context, result.rows[0]) : null;
  }
  async transaction<T>(
    context: AuthContext,
    action: (transaction: PreferenceTransaction) => Promise<T>,
    external?: MetadataQueryExecutor,
  ): Promise<T> {
    const run = async (executor: MetadataQueryExecutor) => {
      const parameters = accountParameters(context);
      // 用户行在创建偏好前已经存在；该锁也能串行首次写入，避免多键和确认之间的锁序倒置。
      const owner = await executor.execute({
        sql: "SELECT id FROM dbo.users WITH (UPDLOCK,HOLDLOCK) WHERE id=@user AND organization_id=@org AND status='active'",
        parameters,
      });
      if (!owner.rows[0]) throw new ApplicationError("UNAUTHORIZED", "账号当前不可保存个人记忆");
      const transaction: PreferenceTransaction = {
        executor,
        find: (key) => this.findWith(executor, context, key),
        put: async (raw) => {
          const record = preferenceRecordSchema.parse(raw);
          assertAccount(context, record);
          await executor.execute({
            sql: "UPDATE dbo.user_preferences SET version=@version,preference_json=@json WHERE organization_id=@org AND user_id=@user AND preference_key=@key; IF @@ROWCOUNT=0 INSERT INTO dbo.user_preferences (organization_id,user_id,preference_key,version,preference_json) VALUES (@org,@user,@key,@version,@json)",
            parameters: [
              ...parameters,
              parameter("key", record.key),
              { name: "version", type: "integer", value: record.version },
              parameter("json", JSON.stringify(record)),
            ],
          });
        },
        findOperation: async (key) => {
          const result = await executor.execute({
            sql: "SELECT request_hash,result_json FROM dbo.preference_operations WHERE organization_id=@org AND user_id=@user AND idempotency_key=@key",
            parameters: [...parameters, parameter("key", key)],
          });
          if (!result.rows[0]) return null;
          return parseStoredRecord(() => {
            const row = preferenceOperationRowSchema.parse(result.rows[0]);
            const storedResult = preferenceOperationResultSchema.parse(JSON.parse(row.result_json));
            const record = preferenceOperationSchema.parse({
              request_hash: row.request_hash,
              result: storedResult.result,
            });
            const value = record.result;
            if (value)
              assertAccount(
                context,
                "status" in value
                  ? value.status === "saved"
                    ? value.preference
                    : value.confirmation
                  : value,
              );
            return record;
          });
        },
        putOperation: async (key, raw) => {
          const record = preferenceOperationSchema.parse(raw);
          await executor.execute({
            sql: "INSERT INTO dbo.preference_operations (organization_id,user_id,idempotency_key,request_hash,result_json) VALUES (@org,@user,@key,@hash,@json)",
            parameters: [
              ...parameters,
              parameter("key", key),
              parameter("hash", record.request_hash),
              parameter("json", JSON.stringify({ result: record.result })),
            ],
          });
        },
        findConfirmation: async (id) => {
          const result = await executor.execute({
            sql: "SELECT record_json FROM dbo.preference_confirmations WHERE organization_id=@org AND user_id=@user AND confirmation_id=@id",
            parameters: [...parameters, parameter("id", id)],
          });
          if (!result.rows[0]) return null;
          return parseStoredRecord(() => {
            const row = preferenceJsonRowSchema.parse(result.rows[0]);
            const record = preferenceConfirmationRecordSchema.parse(JSON.parse(row.record_json));
            assertAccount(context, record);
            if (record.confirmation_id !== id) throw new Error("确认标识不一致");
            return record;
          });
        },
        putConfirmation: async (raw) => {
          const record = preferenceConfirmationRecordSchema.parse(raw);
          assertAccount(context, record);
          await executor.execute({
            sql: "UPDATE dbo.preference_confirmations SET record_json=@json WHERE organization_id=@org AND user_id=@user AND confirmation_id=@id; IF @@ROWCOUNT=0 INSERT INTO dbo.preference_confirmations (organization_id,user_id,confirmation_id,record_json) VALUES (@org,@user,@id,@json)",
            parameters: [
              ...parameters,
              parameter("id", record.confirmation_id),
              parameter("json", JSON.stringify(record)),
            ],
          });
        },
        addSource: async (key, hash, raw, isObservation) => {
          const source = memorySourceSchema.parse(raw);
          z.string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(hash);
          const sourceParameters = [...parameters, parameter("key", key), parameter("hash", hash)];
          const result = await executor.execute({
            sql: "SELECT source_json FROM dbo.preference_sources WHERE organization_id=@org AND user_id=@user AND preference_key=@key AND source_hash=@hash",
            parameters: sourceParameters,
          });
          const previous = result.rows[0]
            ? parseStoredRecord(() =>
                preferenceSourceRecordSchema.parse(
                  JSON.parse(preferenceSourceRowSchema.parse(result.rows[0]).source_json),
                ),
              )
            : null;
          if (previous && (!isObservation || previous.observed)) return false;
          const record = preferenceSourceRecordSchema.parse({ source, observed: isObservation });
          await executor.execute({
            sql: previous
              ? "UPDATE dbo.preference_sources SET source_json=@json WHERE organization_id=@org AND user_id=@user AND preference_key=@key AND source_hash=@hash"
              : "INSERT INTO dbo.preference_sources (organization_id,user_id,preference_key,source_hash,source_json) VALUES (@org,@user,@key,@hash,@json)",
            parameters: [...sourceParameters, parameter("json", JSON.stringify(record))],
          });
          return true;
        },
        audit: async (raw) => {
          const record = preferenceAuditSchema.parse(raw);
          assertAccount(context, record);
          await executor.execute({
            sql: "INSERT INTO dbo.preference_audits (audit_id,organization_id,user_id,record_json) VALUES (@id,@org,@user,@json)",
            parameters: [
              ...parameters,
              parameter("id", record.audit_id),
              parameter("json", JSON.stringify(record)),
            ],
          });
        },
      };
      return action(transaction);
    };
    return external ? run(external) : this.database.transaction(run);
  }
}

export { SqlPreferenceRepository };
