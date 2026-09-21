import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDispatcher } from "../../src/memory/memory-dispatcher";
import { context } from "../support/api-fixtures";
import type { MemoryEvent } from "../../src/memory/memory-event-types";

afterEach(() => vi.useRealTimers());
function fixture() {
  const event = {
    event_id: "event",
    organization_id: context.organizationId,
    user_id: context.userId,
    session_id: context.sessionId,
    attempts: 1,
  } as MemoryEvent;
  const repository = {
    claim: vi.fn().mockResolvedValueOnce(event).mockResolvedValue(null),
    complete: vi.fn(async (_event, effect) => {
      await effect({});
    }),
    renew: vi.fn(),
    release: vi.fn(),
    fail: vi.fn(),
  };
  const process = vi.fn();
  const onError = vi.fn();
  const refreshContext = vi.fn().mockResolvedValue(context);
  const isForegroundBusy = vi.fn().mockReturnValue(false);
  const worker = new MemoryDispatcher({
    repository,
    process,
    onError,
    refreshContext,
    isForegroundBusy,
    pollMs: 1000,
    leaseMs: 6000,
    timeoutMs: 2000,
    maxAttempts: 3,
  });
  return { worker, repository, process, onError, refreshContext, isForegroundBusy, event };
}
describe("独立记忆任务调度", () => {
  it("前台繁忙时不领取；空闲后刷新身份并处理，重复唤醒受并发限制", async () => {
    const f = fixture();
    f.isForegroundBusy.mockReturnValue(true);
    await f.worker.tick();
    expect(f.repository.claim).not.toHaveBeenCalled();
    f.isForegroundBusy.mockReturnValue(false);
    await Promise.all([f.worker.tick(), f.worker.tick()]);
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(f.refreshContext).toHaveBeenCalledTimes(1);
    expect(f.repository.complete).toHaveBeenCalledTimes(1);
    await f.worker.close();
  });
  it("领域失败按稳定错误码重试，不影响前台运行", async () => {
    const f = fixture();
    f.process.mockRejectedValue(new Error("secret"));
    await f.worker.tick();
    expect(f.repository.fail).toHaveBeenCalledWith(f.event, "INTERNAL_ERROR", 3, 1000);
    expect(f.onError).not.toHaveBeenCalled();
    await f.worker.close();
  });
  it("关闭中断正在处理的任务并释放租约，后续实例可恢复", async () => {
    const f = fixture();
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    f.process.mockImplementation(async (_ctx, _event, _executor, signal) => {
      started();
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    });
    const pending = f.worker.tick();
    await ready;
    await f.worker.close();
    await pending;
    expect(f.repository.release).toHaveBeenCalledWith(f.event);
    expect(f.repository.fail).not.toHaveBeenCalled();
  });
});
