import { vi } from "vitest";
import type {
  MemorySource,
  SaveUserPreferenceInput,
  UserPreferenceInput,
} from "@ai-data/contracts";
import type { AuthContext } from "../../src/auth/auth-types";
import type {
  PreferenceAudit,
  PreferenceOperation,
  PreferenceRecord,
  PreferenceRepository,
  PreferenceTransaction,
  PreferenceConfirmationRecord,
} from "../../src/preferences/preference-types";
import { PreferenceService } from "../../src/preferences/preference-service";

const preferenceUser: AuthContext = {
  organizationId: "org",
  userId: "user",
  sessionId: "session",
  roles: [],
  permissions: [],
  dataPolicies: [],
};
const preferenceInput: SaveUserPreferenceInput = {
  key: "default-time",
  scope: {},
  value: {
    type: "time_range",
    range: { type: "relative", period: "this_year", extent: "full_period" },
  },
  auto_apply: true,
  idempotency_key: "save-1",
};
const habitInput: UserPreferenceInput = {
  key: "habit",
  scope: { source_id: "clinical", object_id: "visits" },
  value: {
    type: "query_habit",
    time_range: { type: "relative", period: "this_year", extent: "full_period" },
    filters: [],
    dimensions: [],
  },
  auto_apply: true,
};
const preferenceSource: MemorySource = {
  conversation_id: "conversation",
  analysis_run_id: "run",
  message_id: "message",
  evidence_ids: ["evidence"],
};

/** 测试替身以同一账号串行事务模拟原子提交，异常时还原全部副作用。 */
class MemoryPreferenceRepository implements PreferenceRepository {
  records = new Map<string, PreferenceRecord>();
  operations = new Map<string, PreferenceOperation>();
  confirmations = new Map<string, PreferenceConfirmationRecord>();
  sources = new Map<string, boolean>();
  audits: PreferenceAudit[] = [];
  private tail = Promise.resolve();
  private scope(context: AuthContext, key: string) {
    return JSON.stringify([context.organizationId, context.userId, key]);
  }
  async list(context: AuthContext) {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.organization_id === context.organizationId &&
          record.user_id === context.userId &&
          !("deleted_at" in record),
      )
      .slice(0, 200);
  }
  async listPendingConfirmations(context: AuthContext) {
    return [...this.confirmations.values()]
      .filter(
        (record) =>
          record.organization_id === context.organizationId &&
          record.user_id === context.userId &&
          record.status === "pending",
      )
      .slice(0, 200);
  }
  async find(context: AuthContext, key: string) {
    return this.records.get(this.scope(context, key)) ?? null;
  }
  async transaction<T>(
    context: AuthContext,
    action: (transaction: PreferenceTransaction) => Promise<T>,
  ): Promise<T> {
    const prior = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await prior;
    const backup = structuredClone({
      records: this.records,
      operations: this.operations,
      confirmations: this.confirmations,
      sources: this.sources,
      audits: this.audits,
    });
    const scope = (key: string) => this.scope(context, key);
    const transaction: PreferenceTransaction = {
      executor: { execute: async () => ({ rows: [], rowsAffected: [] }) },
      find: async (key) => this.records.get(scope(key)) ?? null,
      put: async (record) => {
        this.records.set(scope(record.key), record);
      },
      findOperation: async (key) => this.operations.get(scope(key)) ?? null,
      putOperation: async (key, operation) => {
        this.operations.set(scope(key), operation);
      },
      findConfirmation: async (key) => this.confirmations.get(scope(key)) ?? null,
      putConfirmation: async (record) => {
        this.confirmations.set(scope(record.confirmation_id), record);
      },
      addSource: async (key, hash, _source, isObservation) => {
        const id = scope(key + ":" + hash);
        const observed = this.sources.get(id);
        this.sources.set(id, observed === true || isObservation);
        return observed === undefined || (isObservation && !observed);
      },
      audit: async (record) => {
        this.audits.push(record);
      },
    };
    try {
      return await action(transaction);
    } catch (error) {
      Object.assign(this, backup);
      throw error;
    } finally {
      unlock();
    }
  }
}

function preferenceSetup() {
  const repository = new MemoryPreferenceRepository();
  const authorize = vi.fn(async () => {});
  const validateSource = vi.fn(async () => {});
  const service = new PreferenceService({
    repository,
    authorize,
    validateSource,
    now: () => 1798790400000,
  });
  return { repository, authorize, validateSource, service };
}

export { preferenceUser, preferenceInput, habitInput, preferenceSource, preferenceSetup };
