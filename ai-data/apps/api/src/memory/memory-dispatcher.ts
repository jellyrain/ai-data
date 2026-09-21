import { randomUUID } from "node:crypto";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type { SqlMemoryEventRepository } from "./sql-memory-event-repository";
import type { MemoryEvent } from "./memory-event-types";

/** 后台以独立容量派发；前台繁忙时暂停领取，已领取任务受租约和时限约束。 */
class MemoryDispatcher {
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private task?: Promise<void>;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  constructor(
    private readonly dependencies: {
      repository: Pick<
        SqlMemoryEventRepository,
        "claim" | "complete" | "renew" | "release" | "fail"
      >;
      process(
        context: AuthContext,
        event: MemoryEvent,
        executor: MetadataQueryExecutor,
        signal: AbortSignal,
      ): Promise<void>;
      refreshContext(context: AuthContext): Promise<AuthContext>;
      isForegroundBusy(): boolean;
      onError(error: unknown): void;
      pollMs: number;
      leaseMs: number;
      timeoutMs: number;
      maxAttempts: number;
      concurrency?: number;
    },
  ) {}
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick().catch(this.dependencies.onError);
    }, this.dependencies.pollMs);
    this.timer.unref();
    void this.tick().catch(this.dependencies.onError);
  }
  tick(): Promise<void> {
    if (this.task) return this.task;
    if (this.closed || this.dependencies.isForegroundBusy()) return Promise.resolve();
    this.task = this.poll().finally(() => {
      this.task = undefined;
    });
    return this.task;
  }
  private async poll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (let index = 0; index < (this.dependencies.concurrency ?? 1); index++) {
      if (this.closed || this.dependencies.isForegroundBusy()) break;
      const event = await this.dependencies.repository.claim(
        this.owner,
        this.dependencies.leaseMs,
        this.dependencies.maxAttempts,
      );
      if (!event) break;
      tasks.push(this.execute(event));
    }
    await Promise.all(tasks);
  }
  private async execute(event: MemoryEvent): Promise<void> {
    const { repository } = this.dependencies;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.dependencies.timeoutMs);
    timeout.unref();
    const check = () => {
      if (controller.signal.aborted) throw new ApplicationError("CANCELLED", "记忆任务已中断");
    };
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(
      () => {
        if (renewing) return;
        renewing = repository
          .renew(event, this.dependencies.leaseMs)
          .catch(() => controller.abort())
          .finally(() => {
            renewing = undefined;
          });
      },
      Math.max(100, Math.floor(this.dependencies.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      if (this.closed) controller.abort();
      check();
      const context = await this.dependencies.refreshContext({
        organizationId: event.organization_id,
        userId: event.user_id,
        sessionId: event.session_id,
        roles: [],
        permissions: [],
        dataPolicies: [],
      });
      check();
      // 副作用事务锁定事件行后不再另借连接续租；最终检查保证超期事务回滚。
      clearInterval(heartbeat);
      await renewing;
      check();
      await repository.renew(event, this.dependencies.leaseMs);
      await repository.complete(
        event,
        async (executor) => {
          check();
          await this.dependencies.process(context, event, executor, controller.signal);
          check();
        },
        controller.signal,
      );
    } catch (error) {
      if (this.closed) await repository.release(event);
      else
        await repository.fail(
          event,
          controller.signal.aborted
            ? "TIMEOUT"
            : error instanceof ApplicationError
              ? error.code
              : "INTERNAL_ERROR",
          this.dependencies.maxAttempts,
          Math.min(60000, 1000 * 2 ** Math.min(event.attempts - 1, 6)),
        );
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      await renewing;
      this.controllers.delete(controller);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
    await this.task;
  }
}

export { MemoryDispatcher };
