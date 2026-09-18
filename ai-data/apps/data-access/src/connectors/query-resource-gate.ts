import dayjs from "dayjs";
import type {
  ActiveQueryOptions,
  QueryExecutionOptions,
  QueryResourceConfig,
} from "./query-execution-types";
import { QueryResourceError, queryAbortError } from "./query-resource-error";

/** 已入队任务的调度与中断操作。 */
interface PendingQuery {
  start(): void;
  abort(error: QueryResourceError): void;
}

/** 每源统一管理并发、有限等待、端到端超时及关闭排空。 */
class QueryResourceGate {
  private readonly queue: PendingQuery[] = [];
  private readonly active = new Set<PendingQuery>();
  private readonly idleWaiters: Array<() => void> = [];
  private isClosed = false;

  constructor(private readonly config: QueryResourceConfig) {
    if (
      !Number.isInteger(config.concurrencyLimit) ||
      config.concurrencyLimit < 1 ||
      !Number.isFinite(config.timeoutMs) ||
      config.timeoutMs <= 0
    ) {
      throw new Error("查询资源配置必须为正数，并发容量必须为整数");
    }
  }

  /** 总预算从调用时开始；对调用方返回中断后，名额仍等待任务实际结束。 */
  run<T>(
    task: (options: ActiveQueryOptions) => Promise<T>,
    options: QueryExecutionOptions = {},
  ): Promise<T> {
    if (this.isClosed) return Promise.reject(new QueryResourceError("DATA_SOURCE_UNAVAILABLE"));
    if (options.signal?.aborted) return Promise.reject(queryAbortError(options.signal));
    if (
      this.active.size >= this.config.concurrencyLimit &&
      this.queue.length >= this.config.concurrencyLimit
    ) {
      return Promise.reject(new QueryResourceError("QUERY_LIMIT_EXCEEDED"));
    }
    const timeoutMs = Math.min(options.timeoutMs ?? this.config.timeoutMs, this.config.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new QueryResourceError("QUERY_TIMEOUT"));
    const deadline = dayjs().add(timeoutMs, "millisecond").valueOf();
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const entry: PendingQuery = {
        abort: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          controller.abort(error);
          reject(error);
        },
        start: () => {
          if (settled) return;
          const remainingMs = dayjs(deadline).diff(dayjs());
          if (remainingMs <= 0) {
            entry.abort(new QueryResourceError("QUERY_TIMEOUT"));
            return;
          }
          this.active.add(entry);
          void (async () => {
            try {
              const result = await task({ signal: controller.signal, timeoutMs: remainingMs });
              if (!settled && !dayjs().isBefore(deadline))
                entry.abort(new QueryResourceError("QUERY_TIMEOUT"));
              if (!settled) {
                settled = true;
                resolve(result);
              }
            } catch (error) {
              if (!settled) {
                settled = true;
                reject(error);
              }
            } finally {
              cleanup();
              this.active.delete(entry);
              this.drain();
            }
          })();
        },
      };
      const onAbort = () => entry.abort(queryAbortError(options.signal!));
      const timer = setTimeout(
        () => entry.abort(new QueryResourceError("QUERY_TIMEOUT")),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.active.size < this.config.concurrencyLimit) entry.start();
      else this.queue.push(entry);
    });
  }

  /** 停止接收请求、拒绝排队并取消在途工作，待全部资源归还后完成。 */
  async close(): Promise<void> {
    this.isClosed = true;
    for (const entry of [...this.queue, ...this.active])
      entry.abort(new QueryResourceError("DATA_SOURCE_UNAVAILABLE"));
    if (this.active.size > 0) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (
      !this.isClosed &&
      this.active.size < this.config.concurrencyLimit &&
      this.queue.length > 0
    ) {
      this.queue.shift()!.start();
    }
    if (this.active.size === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
}

export { QueryResourceGate };
