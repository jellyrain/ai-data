import dayjs from "dayjs";
import type { QueryExecutionOptions } from "./query-execution-types";
import { QueryResourceError, queryAbortError } from "./query-resource-error";

/** 驱动执行期管理超时、外部取消和异步原生中断的完成顺序。 */
class DatabaseQueryControl {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cancellations: Promise<void>[] = [];
  private readonly listeners: Array<() => void> = [];
  private readonly onExternalAbort: () => void;

  constructor(
    private readonly options: QueryExecutionOptions,
    timeoutMs: number,
  ) {
    const budget = Math.min(options.timeoutMs ?? timeoutMs, timeoutMs);
    this.deadline = dayjs().add(budget, "millisecond").valueOf();
    this.signal = this.controller.signal;
    this.onExternalAbort = () => this.controller.abort(queryAbortError(options.signal!));
    this.timer = setTimeout(
      () => this.controller.abort(new QueryResourceError("QUERY_TIMEOUT")),
      Math.max(0, budget),
    );
    options.signal?.addEventListener("abort", this.onExternalAbort, { once: true });
    if (options.signal?.aborted) this.onExternalAbort();
    if (!Number.isFinite(budget) || budget <= 0)
      this.controller.abort(new QueryResourceError("QUERY_TIMEOUT"));
  }

  /** 每次借出连接或开始新原生请求前重新检查剩余时间。 */
  get remainingMs(): number {
    this.throwIfCancelled();
    return Math.max(1, dayjs(this.deadline).diff(dayjs()));
  }

  throwIfCancelled(): void {
    if (!this.signal.aborted && !dayjs().isBefore(this.deadline))
      this.controller.abort(new QueryResourceError("QUERY_TIMEOUT"));
    if (this.signal.aborted) throw queryAbortError(this.signal);
  }

  /** 注册一次原生取消动作；异步取消会在资源归还前等待完成。 */
  onCancel(cancel: () => void | Promise<void>): () => void {
    const listener = () => {
      try {
        this.cancellations.push(Promise.resolve(cancel()).catch(() => undefined));
      } catch {
        /* 原生取消失败时，调用方仍等待当前任务结束后清理。 */
      }
    };
    this.listeners.push(listener);
    this.signal.addEventListener("abort", listener, { once: true });
    if (this.signal.aborted) listener();
    return () => this.signal.removeEventListener("abort", listener);
  }

  /** 等待取消动作完成，防止中断晚于连接归还而影响下一次查询。 */
  async finishCancellation(): Promise<void> {
    await Promise.all(this.cancellations);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.onExternalAbort);
    this.listeners.forEach((listener) => this.signal.removeEventListener("abort", listener));
  }
}

/** 将执行期中断与原生超时转换为公共错误，并拒绝取消后的晚到结果。 */
async function runDatabaseQuery<T>(
  options: QueryExecutionOptions,
  timeoutMs: number,
  execute: (control: DatabaseQueryControl) => Promise<T>,
): Promise<T> {
  const control = new DatabaseQueryControl(options, timeoutMs);
  try {
    control.throwIfCancelled();
    const result = await execute(control);
    control.throwIfCancelled();
    return result;
  } catch (error) {
    if (control.signal.aborted) throw queryAbortError(control.signal);
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (["ETIMEOUT", "57014", "DPI-1067", "DPI-1080", "NJS-040"].includes(String(code))) {
      throw new QueryResourceError("QUERY_TIMEOUT", { cause: error });
    }
    throw error;
  } finally {
    control.dispose();
    await control.finishCancellation();
  }
}

export { runDatabaseQuery };
