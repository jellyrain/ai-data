import { createHash, randomUUID } from "node:crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { z } from "zod";
import {
  memorySourceSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceInputSchema,
  saveUserPreferenceResultSchema,
  userPreferenceInputSchema,
  userPreferenceSchema,
  type MemorySource,
  type PreferenceConfirmation,
  type SaveUserPreferenceInput,
  type SaveUserPreferenceResult,
  type UserPreference,
  type UserPreferenceInput,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type {
  PreferenceAudit,
  PreferenceMutationInput,
  PreferenceRecord,
  PreferenceSaveOptions,
  PreferenceServiceDependencies,
  PreferenceTransaction,
} from "./preference-types";

dayjs.extend(utc);
const idSchema = z.string().min(1).max(128);
/** 管理动作的预期版本与幂等标识来自当前用户请求，未知字段拒绝。 */
const mutationSchema = z
  .object({ expected_version: z.number().int().positive(), idempotency_key: idSchema })
  .strict();
/** 仅管理自动应用状态时仍执行版本检查。 */
const autoApplySchema = mutationSchema.extend({ auto_apply: z.boolean() }).strict();

/** 对象键排序让字段书写顺序不影响内容与幂等摘要。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function isLive(record: PreferenceRecord | null): record is UserPreference {
  return record !== null && !("deleted_at" in record);
}
function content(input: UserPreferenceInput): UserPreferenceInput {
  return { key: input.key, scope: input.scope, value: input.value, auto_apply: input.auto_apply };
}
function sameConditions(left: UserPreferenceInput, right: UserPreferenceInput): boolean {
  return hash(left.scope) === hash(right.scope) && hash(left.value) === hash(right.value);
}

/** 按账号保存偏好，在同一事务内提交版本、来源、确认、幂等结果和审计。 */
class PreferenceService {
  constructor(private readonly dependencies: PreferenceServiceDependencies) {}
  private time(): string {
    return dayjs(this.dependencies.now?.() ?? dayjs().valueOf())
      .utcOffset(8 * 60)
      .format("YYYY-MM-DD HH:mm:ss");
  }
  private async validate(
    context: AuthContext,
    input: UserPreferenceInput,
    source: MemorySource,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    await this.dependencies.authorize(context, content(input), executor);
    await this.dependencies.validateSource(context, source, executor);
  }
  async list(context: AuthContext): Promise<UserPreference[]> {
    const records = await this.dependencies.repository.list(context);
    const items: UserPreference[] = [];
    for (const record of records) {
      if (!isLive(record)) continue;
      try {
        await this.validate(context, record, record.source);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          [
            "UNAUTHORIZED",
            "UNAUTHORIZED_OBJECT",
            "UNAUTHORIZED_COLUMN",
            "POLICY_REJECTED",
            "NOT_FOUND",
          ].includes(error.code)
        )
          continue;
        throw error;
      }
      items.push(record);
    }
    return items;
  }
  async get(context: AuthContext, key: string): Promise<UserPreference> {
    const record = await this.dependencies.repository.find(context, idSchema.parse(key));
    if (!isLive(record)) throw new ApplicationError("NOT_FOUND", "个人偏好不存在");
    await this.validate(context, record, record.source);
    return record;
  }
  /** 后续会话只看到仍绑定当前版本且当前可访问的待确认项。 */
  async listPendingConfirmations(context: AuthContext): Promise<PreferenceConfirmation[]> {
    const records = await this.dependencies.repository.listPendingConfirmations(context);
    const items: PreferenceConfirmation[] = [];
    for (const record of records) {
      if (record.status !== "pending") continue;
      const current = await this.dependencies.repository.find(context, record.proposed.key);
      if (!isLive(current) || current.version !== record.expected_version) continue;
      try {
        await this.validate(context, record.proposed, record.source);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          [
            "UNAUTHORIZED",
            "UNAUTHORIZED_OBJECT",
            "UNAUTHORIZED_COLUMN",
            "POLICY_REJECTED",
            "NOT_FOUND",
          ].includes(error.code)
        )
          continue;
        throw error;
      }
      // 从已校验的内部记录投影公共确认字段，查询频次信息留在服务端。
      items.push(preferenceConfirmationSchema.strip().parse(record));
    }
    return items;
  }
  private async audit(
    context: AuthContext,
    transaction: PreferenceTransaction,
    key: string,
    action: PreferenceAudit["action"],
    version: number,
    source?: MemorySource,
    confirmationId?: string,
  ): Promise<void> {
    await transaction.audit({
      audit_id: randomUUID(),
      organization_id: context.organizationId,
      user_id: context.userId,
      key,
      action,
      version,
      at: this.time(),
      ...(source ? { source } : {}),
      ...(confirmationId ? { confirmation_id: confirmationId } : {}),
    });
  }
  private async replay(transaction: PreferenceTransaction, key: string, requestHash: string) {
    const operation = await transaction.findOperation(key);
    if (operation && operation.request_hash !== requestHash)
      throw new ApplicationError("CONFLICT", "幂等键已用于其他偏好操作");
    return operation;
  }
  async save(
    context: AuthContext,
    raw: SaveUserPreferenceInput,
    options: PreferenceSaveOptions = {},
  ): Promise<SaveUserPreferenceResult> {
    const input = saveUserPreferenceInputSchema.parse(raw);
    return this.write(context, input, options, false);
  }
  async observe(
    context: AuthContext,
    raw: UserPreferenceInput,
    rawSource: MemorySource,
    operationKey: string,
    executor?: MetadataQueryExecutor,
  ): Promise<SaveUserPreferenceResult> {
    const input = userPreferenceInputSchema.parse(raw);
    if (input.value.type !== "query_habit")
      throw new ApplicationError("INVALID_INPUT", "后台观察只接受查询习惯");
    const source = memorySourceSchema.parse(rawSource);
    if (!source.analysis_run_id || (!source.message_id && source.evidence_ids.length === 0))
      throw new ApplicationError("INVALID_INPUT", "查询习惯必须关联运行和消息或证据");
    return this.write(
      context,
      { ...input, idempotency_key: idSchema.parse(operationKey) },
      { origin: "background", source, executor },
      true,
    );
  }
  private async write(
    context: AuthContext,
    input: SaveUserPreferenceInput,
    options: PreferenceSaveOptions,
    isObservation: boolean,
  ): Promise<SaveUserPreferenceResult> {
    const source = memorySourceSchema.parse(options.source ?? {});
    source.evidence_ids = [...new Set(source.evidence_ids)].sort();
    const origin = options.origin ?? "tool";
    const requestHash = hash({ action: isObservation ? "observe" : "save", input, source, origin });
    return this.dependencies.repository.transaction(
      context,
      async (transaction) => {
        await this.validate(context, input, source, transaction.executor);
        const prior = await this.replay(transaction, input.idempotency_key, requestHash);
        if (prior) {
          const result = saveUserPreferenceResultSchema.parse(prior.result);
          if (result.status === "confirmation_required") {
            const confirmation = await transaction.findConfirmation(
              result.confirmation.confirmation_id,
            );
            if (confirmation && confirmation.status !== "pending") {
              const current = await transaction.find(input.key);
              if (!isLive(current))
                throw new ApplicationError("CONFLICT", "已处理的偏好已发生变化");
              await this.validate(context, current, current.source, transaction.executor);
              return { status: "saved" as const, preference: current };
            }
          }
          return result;
        }
        const current = await transaction.find(input.key);
        const version = current?.version ?? 0;
        if (input.expected_version !== undefined && input.expected_version !== version)
          throw new ApplicationError("CONFLICT", "个人偏好版本已变化，请重新读取");
        if (current && !isLive(current) && origin !== "user")
          throw new ApplicationError("CONFLICT", "个人偏好已删除，需要用户明确重新设置");
        const previous = isLive(current) ? current : null;
        // 观察只是累积相同条件的使用事实，已有自动应用开关由用户设置决定。
        const proposed = content(
          isObservation && previous ? { ...input, auto_apply: previous.auto_apply } : input,
        );
        const isConflict = previous && !sameConditions(previous, proposed);
        const isRestoring = previous && !previous.auto_apply && proposed.auto_apply;
        let result: SaveUserPreferenceResult;
        if (origin !== "user" && (isConflict || isRestoring)) {
          const confirmation = preferenceConfirmationSchema.parse({
            confirmation_id: randomUUID(),
            organization_id: context.organizationId,
            user_id: context.userId,
            expected_version: version,
            proposed,
            source,
            reason: isRestoring ? "auto_apply_disabled" : "conflict",
            status: "pending",
            created_at: this.time(),
          });
          await transaction.putConfirmation({ ...confirmation, is_observation: isObservation });
          await this.audit(
            context,
            transaction,
            input.key,
            "request_confirmation",
            version,
            source,
            confirmation.confirmation_id,
          );
          result = { status: "confirmation_required", confirmation };
        } else {
          const hasSource = Boolean(
            source.analysis_run_id ||
            source.message_id ||
            source.conversation_id ||
            source.evidence_ids.length,
          );
          const isNewSource = hasSource
            ? await transaction.addSource(input.key, hash(source), source, isObservation)
            : false;
          if (isObservation && previous && !isNewSource)
            result = { status: "saved", preference: previous };
          else {
            const preference = userPreferenceSchema.parse({
              ...proposed,
              organization_id: context.organizationId,
              user_id: context.userId,
              version: version + 1,
              source,
              updated_at: this.time(),
              use_count:
                (isConflict ? 0 : (previous?.use_count ?? 0)) +
                (isObservation && isNewSource ? 1 : 0),
              last_used_at:
                isObservation && isNewSource
                  ? this.time()
                  : isConflict
                    ? null
                    : (previous?.last_used_at ?? null),
            });
            await transaction.put(preference);
            await this.audit(
              context,
              transaction,
              input.key,
              isObservation ? "observe" : "save",
              preference.version,
              source,
            );
            result = { status: "saved", preference };
          }
        }
        await transaction.putOperation(input.idempotency_key, {
          request_hash: requestHash,
          result,
        });
        return result;
      },
      options.executor,
    );
  }
  async confirm(
    context: AuthContext,
    confirmationId: string,
    approved: boolean,
    idempotencyKey: string,
    executor?: MetadataQueryExecutor,
  ): Promise<UserPreference | null> {
    idSchema.parse(confirmationId);
    idSchema.parse(idempotencyKey);
    z.boolean().parse(approved);
    const requestHash = hash({ action: "confirm", confirmationId, approved });
    return this.dependencies.repository.transaction(
      context,
      async (transaction) => {
        const confirmation = await transaction.findConfirmation(confirmationId);
        if (!confirmation) throw new ApplicationError("NOT_FOUND", "偏好确认不存在");
        if (approved)
          await this.validate(
            context,
            confirmation.proposed,
            confirmation.source,
            transaction.executor,
          );
        const prior = await this.replay(transaction, idempotencyKey, requestHash);
        if (prior) return prior.result === null ? null : userPreferenceSchema.parse(prior.result);
        if (confirmation.status !== "pending")
          throw new ApplicationError("CONFLICT", "偏好确认已处理");
        const current = await transaction.find(confirmation.proposed.key);
        if (!isLive(current) || current.version !== confirmation.expected_version)
          throw new ApplicationError("CONFLICT", "偏好在确认期间已变化，请重新设置");
        let preference: UserPreference | null = null;
        if (approved) {
          const isNewObservation = await transaction.addSource(
            current.key,
            hash(confirmation.source),
            confirmation.source,
            confirmation.is_observation,
          );
          const hasSameConditions = sameConditions(current, confirmation.proposed);
          const isNewUse = confirmation.is_observation && isNewObservation;
          preference = userPreferenceSchema.parse({
            ...current,
            ...confirmation.proposed,
            version: current.version + 1,
            source: confirmation.source,
            updated_at: this.time(),
            use_count: (hasSameConditions ? current.use_count : 0) + (isNewUse ? 1 : 0),
            last_used_at: isNewUse ? this.time() : hasSameConditions ? current.last_used_at : null,
          });
          await transaction.put(preference);
        }
        await transaction.putConfirmation({
          ...confirmation,
          status: approved ? "accepted" : "rejected",
        });
        await this.audit(
          context,
          transaction,
          current.key,
          approved ? "confirm" : "reject",
          preference?.version ?? current.version,
          confirmation.source,
          confirmationId,
        );
        await transaction.putOperation(idempotencyKey, {
          request_hash: requestHash,
          result: preference,
        });
        return preference;
      },
      executor,
    );
  }
  async delete(
    context: AuthContext,
    key: string,
    raw: PreferenceMutationInput,
    executor?: MetadataQueryExecutor,
  ): Promise<void> {
    idSchema.parse(key);
    const input = mutationSchema.parse(raw);
    const requestHash = hash({ action: "delete", key, input });
    await this.dependencies.repository.transaction(
      context,
      async (transaction) => {
        if (await this.replay(transaction, input.idempotency_key, requestHash)) return;
        const current = await transaction.find(key);
        if (!isLive(current)) throw new ApplicationError("NOT_FOUND", "个人偏好不存在");
        if (current.version !== input.expected_version)
          throw new ApplicationError("CONFLICT", "个人偏好版本已变化，请重新读取");
        await transaction.put({
          organization_id: context.organizationId,
          user_id: context.userId,
          key,
          version: current.version + 1,
          deleted_at: this.time(),
        });
        await this.audit(context, transaction, key, "delete", current.version + 1);
        await transaction.putOperation(input.idempotency_key, {
          request_hash: requestHash,
          result: null,
        });
      },
      executor,
    );
  }
  async setAutoApply(
    context: AuthContext,
    key: string,
    raw: PreferenceMutationInput & { auto_apply: boolean },
    executor?: MetadataQueryExecutor,
  ): Promise<UserPreference> {
    idSchema.parse(key);
    const input = autoApplySchema.parse(raw);
    const requestHash = hash({ action: "auto_apply", key, input });
    return this.dependencies.repository.transaction(
      context,
      async (transaction) => {
        const prior = await this.replay(transaction, input.idempotency_key, requestHash);
        if (prior) {
          const result = userPreferenceSchema.parse(prior.result);
          await this.validate(context, result, result.source, transaction.executor);
          return result;
        }
        const current = await transaction.find(key);
        if (!isLive(current)) throw new ApplicationError("NOT_FOUND", "个人偏好不存在");
        if (current.version !== input.expected_version)
          throw new ApplicationError("CONFLICT", "个人偏好版本已变化，请重新读取");
        await this.validate(context, current, current.source, transaction.executor);
        const preference = userPreferenceSchema.parse({
          ...current,
          auto_apply: input.auto_apply,
          version: current.version + 1,
          updated_at: this.time(),
        });
        await transaction.put(preference);
        await this.audit(context, transaction, key, "auto_apply", preference.version);
        await transaction.putOperation(input.idempotency_key, {
          request_hash: requestHash,
          result: preference,
        });
        return preference;
      },
      executor,
    );
  }
}

export { PreferenceService };
