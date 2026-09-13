import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryResourceGate } from "../../src/connectors/query-resource-gate";

/** 可控任务结束点，用于区分调用方已取消与底层资源实际归还。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("数据源查询资源限制", () => {
  afterEach(() => vi.useRealTimers());

  it("活动数和等待容量各等于并发上限，队列满立即拒绝并保持先进先出", async () => {
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 1000 });
    const first = deferred<number>();
    const starts: number[] = [];
    const running = gate.run(async () => {
      starts.push(1);
      return first.promise;
    });
    const queued = gate.run(async () => {
      starts.push(2);
      return 2;
    });
    await expect(gate.run(async () => 3)).rejects.toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
    expect(starts).toEqual([1]);
    first.resolve(1);
    await expect(running).resolves.toBe(1);
    await expect(queued).resolves.toBe(2);
    expect(starts).toEqual([1, 2]);
  });

  it("等待中取消立即移除，后续请求可以使用该等待位置", async () => {
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 1000 });
    const first = deferred<number>();
    const running = gate.run(() => first.promise);
    const controller = new AbortController();
    const task = vi.fn(async () => 2);
    const queued = gate.run(task, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
    const replacement = gate.run(async () => 3);
    first.resolve(1);
    await running;
    await expect(replacement).resolves.toBe(3);
    expect(task).not.toHaveBeenCalled();
  });

  it("等待超时计入查询总预算，超时请求不会开始执行", async () => {
    vi.useFakeTimers();
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 1000 });
    const first = deferred<number>();
    const running = gate.run(() => first.promise);
    const task = vi.fn(async () => 2);
    const queued = gate.run(task, { timeoutMs: 50 });
    const rejected = expect(queued).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    first.resolve(1);
    await running;
    expect(task).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("执行得到扣除排队耗时后的预算，配置超时限制更长的请求预算", async () => {
    vi.useFakeTimers();
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 100 });
    const first = deferred<number>();
    const running = gate.run(() => first.promise);
    const task = vi.fn(async ({ timeoutMs }: { timeoutMs: number }) => timeoutMs);
    const queued = gate.run(task, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(35);
    first.resolve(1);
    await running;
    await expect(queued).resolves.toBe(65);
  });

  it("在途取消传播到底层且拒绝晚到结果，资源归还后才启动等待者", async () => {
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 1000 });
    const first = deferred<number>();
    const controller = new AbortController();
    let signal!: AbortSignal;
    const running = gate.run(
      async (options) => {
        signal = options.signal;
        return first.promise;
      },
      { signal: controller.signal },
    );
    const next = vi.fn(async () => 2);
    const queued = gate.run(next);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(signal.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    await expect(gate.run(async () => 3)).rejects.toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
    first.resolve(99);
    await expect(queued).resolves.toBe(2);
  });

  it("执行超时发出稳定原因并保留名额直到任务清理完毕", async () => {
    vi.useFakeTimers();
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 100 });
    const finish = deferred<number>();
    let signal!: AbortSignal;
    const running = gate.run(async (options) => {
      signal = options.signal;
      return finish.promise;
    });
    const rejected = expect(running).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal.reason).toMatchObject({ code: "QUERY_TIMEOUT" });
    const next = vi.fn(async () => 2);
    const queued = gate.run(next);
    expect(next).not.toHaveBeenCalled();
    finish.resolve(1);
    await queued;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("关闭拒绝等待者和新请求，并等待在途清理完成", async () => {
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 1000 });
    const finish = deferred<number>();
    const running = gate.run(() => finish.promise);
    const task = vi.fn(async () => 2);
    const queued = gate.run(task);
    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    await expect(running).rejects.toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
    await expect(queued).rejects.toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
    await expect(gate.run(task)).rejects.toMatchObject({ code: "DATA_SOURCE_UNAVAILABLE" });
    expect(closed).toBe(false);
    finish.resolve(1);
    await closing;
    expect(closed).toBe(true);
    expect(task).not.toHaveBeenCalled();
  });

  it("已取消请求不执行，正常完成后移除外部监听器和计时器", async () => {
    vi.useFakeTimers();
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 100 });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await gate.run(async () => 1, { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    const task = vi.fn(async () => 2);
    await expect(gate.run(task, { signal: controller.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(task).not.toHaveBeenCalled();
  });

  it("同步转换越过截止时间且计时器尚未回调时，仍拒绝超时结果", async () => {
    vi.useFakeTimers();
    const gate = new QueryResourceGate({ concurrencyLimit: 1, timeoutMs: 100 });
    await expect(
      gate.run(async () => {
        vi.setSystemTime(Date.now() + 101);
        return 7;
      }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
