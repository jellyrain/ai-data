import type { AuthContext } from "../auth/auth-types";
import type { AnalysisExecutor } from "./analysis-executor";
import type { RuntimeRepository } from "./runtime-types";
import { ApplicationError } from "../errors/application-error";

/** 元数据库队列是恢复依据；进程内集合只控制当前实例的并发数。 */
class PollingAnalysisDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;
  private readonly active = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private pollTask?: Promise<void>;
  constructor(
    private readonly dependencies: {
      repository: RuntimeRepository;
      executor: AnalysisExecutor;
      refreshContext: (context: AuthContext) => Promise<AuthContext>;
      onError: (error: unknown) => void;
      concurrency?: number;
      pollMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.wake(), this.dependencies.pollMs ?? 1000);
    this.timer.unref();
    this.wake();
  }
  isBusy(): boolean {
    return this.active.size > 0;
  }
  wake(): void {
    if (this.pollTask || this.closed) return;
    this.pollTask = this.poll()
      .catch(this.dependencies.onError)
      .finally(() => {
        this.pollTask = undefined;
      });
  }
  private async poll(): Promise<void> {
    const available = (this.dependencies.concurrency ?? 2) - this.active.size;
    if (this.closed || this.polling || available <= 0) return;
    this.polling = true;
    try {
      const tasks = await this.dependencies.repository.pending(
        (this.dependencies.concurrency ?? 2) * 2,
      );
      for (const task of tasks) {
        if (this.closed || this.active.size >= (this.dependencies.concurrency ?? 2)) break;
        if (this.active.has(task.runId)) continue;
        this.active.add(task.runId);
        const execution = (async () => {
          try {
            const context = await this.dependencies.refreshContext({
              ...task,
              roles: [],
              permissions: [],
              dataPolicies: [],
            });
            if (!this.closed) await this.dependencies.executor.execute(context, task.runId);
          } catch (error) {
            if (error instanceof ApplicationError && error.code === "AUTHENTICATION_FAILED")
              await this.dependencies.repository.rejectPending(task, error.code);
            else this.dependencies.onError(error);
          } finally {
            this.active.delete(task.runId);
          }
        })().catch(this.dependencies.onError);
        this.tasks.add(execution);
        void execution.finally(() => this.tasks.delete(execution));
      }
    } finally {
      this.polling = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pollTask;
    await this.dependencies.executor.close();
    await Promise.allSettled(this.tasks);
  }
}
export { PollingAnalysisDispatcher };
