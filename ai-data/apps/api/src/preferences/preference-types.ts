import type { z } from "zod";
import type { MemorySource, UserPreferenceInput } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type {
  preferenceAuditSchema,
  preferenceOperationSchema,
  preferenceRecordSchema,
  preferenceTombstoneSchema,
  preferenceConfirmationRecordSchema,
} from "./preference-records";

/** 已删除偏好的最小版本标记。 */
type PreferenceTombstone = z.infer<typeof preferenceTombstoneSchema>;
/** 当前值或删除标记，均经过持久化合同校验。 */
type PreferenceRecord = z.infer<typeof preferenceRecordSchema>;
/** 一个已提交的幂等操作及响应。 */
type PreferenceOperation = z.infer<typeof preferenceOperationSchema>;
/** 一条个人记忆操作审计。 */
type PreferenceAudit = z.infer<typeof preferenceAuditSchema>;
/** 持久化确认包含来源是否代表一次实际使用的信息。 */
type PreferenceConfirmationRecord = z.infer<typeof preferenceConfirmationRecordSchema>;
/** 同一账号事务内的读写能力；SQL 实现先锁定账号再提供这些操作。 */
interface PreferenceTransaction {
  executor: MetadataQueryExecutor;
  find(key: string): Promise<PreferenceRecord | null>;
  put(record: PreferenceRecord): Promise<void>;
  findOperation(key: string): Promise<PreferenceOperation | null>;
  putOperation(key: string, operation: PreferenceOperation): Promise<void>;
  findConfirmation(id: string): Promise<PreferenceConfirmationRecord | null>;
  putConfirmation(confirmation: PreferenceConfirmationRecord): Promise<void>;
  addSource(
    key: string,
    sourceHash: string,
    source: MemorySource,
    isObservation: boolean,
  ): Promise<boolean>;
  audit(record: PreferenceAudit): Promise<void>;
}
/** 仓储按组织及账号过滤，并让外层工作事务复用同一执行器。 */
interface PreferenceRepository {
  list(context: AuthContext): Promise<PreferenceRecord[]>;
  listPendingConfirmations(context: AuthContext): Promise<PreferenceConfirmationRecord[]>;
  find(context: AuthContext, key: string): Promise<PreferenceRecord | null>;
  transaction<T>(
    context: AuthContext,
    action: (transaction: PreferenceTransaction) => Promise<T>,
    executor?: MetadataQueryExecutor,
  ): Promise<T>;
}
/** 可信调用方选择保存来源；模型输入合同中不包含该信任判定。 */
type PreferenceSaveOptions = {
  origin?: "user" | "tool" | "background";
  source?: MemorySource;
  executor?: MetadataQueryExecutor;
};
/** 偏好服务在每次读取和写入时复核当前资源权限及来源归属。 */
type PreferenceServiceDependencies = {
  repository: PreferenceRepository;
  authorize(
    context: AuthContext,
    input: UserPreferenceInput,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  validateSource(
    context: AuthContext,
    source: MemorySource,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  now?: () => number;
};
/** 管理入口必须提交当前版本和幂等键，确保用户操作不会覆盖并发更新。 */
type PreferenceMutationInput = { expected_version: number; idempotency_key: string };

export type {
  PreferenceTombstone,
  PreferenceRecord,
  PreferenceOperation,
  PreferenceAudit,
  PreferenceTransaction,
  PreferenceRepository,
  PreferenceSaveOptions,
  PreferenceServiceDependencies,
  PreferenceMutationInput,
  PreferenceConfirmationRecord,
};
