import dayjs from "dayjs";
import { memoryEventSummarySchema, type MemoryEventSummary } from "@ai-data/contracts";
import type {
  MetadataTransactionalExecutor,
  MetadataQueryExecutor,
  MetadataParameter,
} from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { memoryEventRecordSchema } from "./memory-event-record";
import type { MemoryEvent } from "./memory-event-types";

const summaryColumns = `event_id,analysis_run_id,status,attempts,
  CONVERT(varchar(19),DATEADD(hour,8,created_at),120) AS created_at,
  CONVERT(varchar(19),DATEADD(hour,8,updated_at),120) AS updated_at,last_error_code`;
const leasePredicate =
  "event_id=@id AND status='processing' AND lease_owner=@owner AND lease_epoch=@epoch AND lease_expires_at>@now";

/** SQL 租约控制多实例竞争；领域副作用和 done 状态在同一事务中提交。 */
class SqlMemoryEventRepository {
  private readonly now: () => number;
  constructor(
    private readonly database: MetadataTransactionalExecutor,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => dayjs().valueOf());
  }
  private parameters(event: MemoryEvent): MetadataParameter[] {
    return [
      { name: "id", type: "string", value: event.event_id },
      { name: "owner", type: "string", value: event.lease_owner },
      { name: "epoch", type: "integer", value: event.lease_epoch },
      { name: "now", type: "date", value: dayjs(this.now()).toDate() },
    ];
  }
  async list(context: AuthContext, limit: number): Promise<MemoryEventSummary[]> {
    const result = await this.database.execute({
      sql: `SELECT TOP (@limit) ${summaryColumns} FROM dbo.memory_events WHERE organization_id=@org ORDER BY created_at DESC,event_id`,
      parameters: [
        { name: "limit", type: "integer", value: Math.max(1, Math.min(200, Math.floor(limit))) },
        { name: "org", type: "string", value: context.organizationId },
      ],
    });
    try {
      return result.rows.map((row) => memoryEventSummarySchema.parse(row));
    } catch (cause) {
      throw new ApplicationError("INTERNAL_ERROR", "记忆任务记录无效", { cause });
    }
  }
  async claim(owner: string, leaseMs: number, maxAttempts: number): Promise<MemoryEvent | null> {
    return this.database.transaction(async (executor) => {
      const parameters: MetadataParameter[] = [
        { name: "owner", type: "string", value: owner },
        { name: "now", type: "date", value: dayjs(this.now()).toDate() },
        {
          name: "expires",
          type: "date",
          value: dayjs(this.now()).add(leaseMs, "millisecond").toDate(),
        },
        { name: "max", type: "integer", value: maxAttempts },
      ];
      // 耗尽重试的崩溃任务必须进入 failed，供管理端重新派发。
      await executor.execute({
        sql: `UPDATE dbo.memory_events WITH (ROWLOCK) SET status='failed',lease_owner=NULL,lease_expires_at=NULL,last_error_code='TIMEOUT',updated_at=@now WHERE status='processing' AND lease_expires_at<=@now AND attempts>=@max`,
        parameters,
      });
      const result = await executor.execute({
        sql: `SELECT TOP (1) event_id FROM dbo.memory_events WITH (UPDLOCK,READPAST,ROWLOCK)
        WHERE attempts<@max AND ((status='pending' AND next_attempt_at<=@now) OR (status='processing' AND lease_expires_at<=@now))
        ORDER BY next_attempt_at,created_at,event_id`,
        parameters,
      });
      const id = result.rows[0]?.event_id;
      if (typeof id !== "string") return null;
      parameters.push({ name: "id", type: "string", value: id });
      const updated = await executor.execute({
        sql: `UPDATE dbo.memory_events SET status='processing',lease_owner=@owner,lease_epoch=lease_epoch+1,lease_expires_at=@expires,attempts=attempts+1,updated_at=@now WHERE event_id=@id;
        SELECT ${summaryColumns},organization_id,user_id,session_id,intent_key,intent_json,lease_owner,lease_epoch FROM dbo.memory_events WHERE event_id=@id`,
        parameters,
      });
      const row = updated.rows[0]!;
      try {
        const { intent_json: json, ...record } = row;
        return memoryEventRecordSchema.parse({
          ...record,
          intent: JSON.parse(String(json)) as unknown,
        });
      } catch (cause) {
        throw new ApplicationError("INTERNAL_ERROR", "记忆任务内容无效", { cause });
      }
    });
  }
  private async assertLease(
    executor: MetadataQueryExecutor,
    event: MemoryEvent,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new ApplicationError("CANCELLED", "记忆处理已中断");
    const result = await executor.execute({
      sql: `SELECT event_id FROM dbo.memory_events WITH (UPDLOCK,ROWLOCK) WHERE ${leasePredicate}`,
      parameters: this.parameters(event),
    });
    if (!result.rows.length) throw new ApplicationError("CONFLICT", "记忆任务租约已失效");
  }
  async complete(
    event: MemoryEvent,
    effect: (executor: MetadataQueryExecutor) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.database.transaction(async (executor) => {
      await this.assertLease(executor, event, signal);
      await effect(executor);
      await this.assertLease(executor, event, signal);
      await executor.execute({
        sql: `UPDATE dbo.memory_events SET status='done',lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=@now WHERE ${leasePredicate}`,
        parameters: this.parameters(event),
      });
    });
  }
  async renew(event: MemoryEvent, leaseMs: number): Promise<void> {
    const result = await this.database.execute({
      sql: `UPDATE dbo.memory_events SET lease_expires_at=@expires,updated_at=@now OUTPUT inserted.event_id WHERE ${leasePredicate}`,
      parameters: [
        ...this.parameters(event),
        {
          name: "expires",
          type: "date",
          value: dayjs(this.now()).add(leaseMs, "millisecond").toDate(),
        },
      ],
    });
    if (!result.rows.length) throw new ApplicationError("CONFLICT", "记忆任务租约已失效");
  }
  async release(event: MemoryEvent): Promise<void> {
    await this.database.execute({
      sql: `UPDATE dbo.memory_events SET status='pending',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=@now,updated_at=@now WHERE ${leasePredicate}`,
      parameters: this.parameters(event),
    });
  }
  async fail(
    event: MemoryEvent,
    code: string,
    maxAttempts: number,
    retryDelayMs: number,
  ): Promise<void> {
    await this.database.execute({
      sql: `UPDATE dbo.memory_events SET status=CASE WHEN attempts>=@max THEN 'failed' ELSE 'pending' END,lease_owner=NULL,lease_expires_at=NULL,last_error_code=@code,next_attempt_at=@next,updated_at=@now WHERE ${leasePredicate}`,
      parameters: [
        ...this.parameters(event),
        { name: "code", type: "string", value: code },
        { name: "max", type: "integer", value: maxAttempts },
        {
          name: "next",
          type: "date",
          value: dayjs(this.now()).add(retryDelayMs, "millisecond").toDate(),
        },
      ],
    });
  }
  async retry(context: AuthContext, eventId: string): Promise<void> {
    await this.database.transaction(async (executor) => {
      const parameters: MetadataParameter[] = [
        { name: "id", type: "string", value: eventId },
        { name: "org", type: "string", value: context.organizationId },
        { name: "now", type: "date", value: dayjs(this.now()).toDate() },
      ];
      const existing = await executor.execute({
        sql: "SELECT status FROM dbo.memory_events WITH (UPDLOCK,ROWLOCK) WHERE event_id=@id AND organization_id=@org",
        parameters,
      });
      if (!existing.rows.length) throw new ApplicationError("NOT_FOUND", "记忆任务不存在");
      if (existing.rows[0]!.status !== "failed")
        throw new ApplicationError("CONFLICT", "仅失败任务可重新派发");
      await executor.execute({
        sql: "UPDATE dbo.memory_events SET status='pending',attempts=0,lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,next_attempt_at=@now,updated_at=@now WHERE event_id=@id AND organization_id=@org",
        parameters,
      });
    });
  }
}

export { SqlMemoryEventRepository };
