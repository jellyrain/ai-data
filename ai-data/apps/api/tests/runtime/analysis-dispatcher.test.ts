import { describe, expect, it, vi } from "vitest";
import { PollingAnalysisDispatcher } from "../../src/runtime/analysis-dispatcher";
import { ApplicationError } from "../../src/errors/application-error";
import { context } from "../support/api-fixtures";

function setup() {
  const repository = {
    pending: vi.fn(async () => [
      {
        runId: "run",
        userId: context.userId,
        organizationId: context.organizationId,
        sessionId: context.sessionId,
      },
    ]),
    rejectPending: vi.fn(async () => {}),
    loadInput: vi.fn(),
  };
  const executor = { execute: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const refreshContext = vi.fn(async () => context);
  const onError = vi.fn();
  const dispatcher = new PollingAnalysisDispatcher({
    repository,
    executor,
    refreshContext,
    onError,
    concurrency: 1,
  } as unknown as ConstructorParameters<typeof PollingAnalysisDispatcher>[0]);
  return { repository, executor, refreshContext, onError, dispatcher };
}
describe("持久化运行派发", () => {
  it("重复唤醒在当前执行未结束时只派发一次", async () => {
    const h = setup();
    let finish!: () => void;
    h.executor.execute.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    h.dispatcher.wake();
    h.dispatcher.wake();
    await vi.waitFor(() => expect(h.executor.execute).toHaveBeenCalledOnce());
    h.dispatcher.wake();
    expect(h.executor.execute).toHaveBeenCalledOnce();
    finish();
    await h.dispatcher.close();
  });
  it("恢复时已撤销的身份记录失败，模型不执行", async () => {
    const h = setup();
    h.refreshContext.mockRejectedValue(new ApplicationError("AUTHENTICATION_FAILED", "会话无效"));
    h.dispatcher.wake();
    await vi.waitFor(() => expect(h.repository.rejectPending).toHaveBeenCalledOnce());
    expect(h.executor.execute).not.toHaveBeenCalled();
    await h.dispatcher.close();
  });
  it("关闭等待在途身份读取结束，随后不再派发模型", async () => {
    const h = setup();
    let finish!: () => void;
    h.refreshContext.mockImplementation(
      () =>
        new Promise<typeof context>((resolve) => {
          finish = () => resolve(context);
        }),
    );
    h.dispatcher.wake();
    await vi.waitFor(() => expect(h.refreshContext).toHaveBeenCalledOnce());
    let closed = false;
    const closing = h.dispatcher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(h.executor.execute).not.toHaveBeenCalled();
  });
});
