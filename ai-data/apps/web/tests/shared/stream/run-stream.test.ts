import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRunState, SseEvent } from "@ai-data/contracts";
import { subscribeRun } from "../../../src/shared/stream/run-stream";
import { ApiError } from "../../../src/shared/http/api-error";

const base = { conversation_id: "c", analysis_run_id: "r" };
const completed: AnalysisRunState = {
  ...base,
  organization_id: "o",
  user_id: "u",
  status: "completed",
  sequence: 2,
  created_at: "2026-09-27 08:00:00",
  updated_at: "2026-09-27 08:00:01",
  lease_epoch: 1,
  lease: null,
  clarification: null,
  evidence_ids: [],
  error: null,
};
const final: SseEvent = { ...base, type: "final_answer", sequence: 1, content: "最终结论" };
const end: SseEvent = { ...base, type: "run_completed", sequence: 2 };

function response(events: SseEvent[]) {
  const text = events
    .map(
      (event) => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.useRealTimers());

describe("可恢复的运行订阅", () => {
  it("增量正文断线从最后提交序号续接，重复片段不二次交付", async () => {
    vi.useFakeTimers();
    const first: SseEvent = {
      ...base,
      sequence: 1,
      type: "assistant_message",
      message_id: "message",
      status: "delta",
      content: "查询",
    };
    const second: SseEvent = { ...first, sequence: 2, content: "完成" };
    const last: SseEvent = { ...base, sequence: 3, type: "run_completed" };
    const onEvent = vi.fn();
    let count = 0;
    const open = vi.fn(async () => response(++count === 1 ? [first] : [first, second, last]));
    const task = subscribeRun({
      conversationId: "c",
      runId: "r",
      signal: new AbortController().signal,
      open,
      snapshot: async () => ({
        ...completed,
        sequence: count > 1 ? 3 : 1,
        status: count > 1 ? "completed" : "running",
      }),
      onSnapshot: vi.fn(),
      onEvent,
    });
    await vi.runAllTimersAsync();
    await task;
    expect(onEvent.mock.calls.map(([event]) => event.sequence)).toEqual([1, 2, 3]);
  });
  it("页面退出会取消读取，迟到数据不会被应用", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const onEvent = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const task = subscribeRun({
      conversationId: "c",
      runId: "r",
      signal: controller.signal,
      open: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      snapshot: async () => ({ ...completed, status: "running", sequence: 0 }),
      onEvent,
      onSnapshot: vi.fn(),
    });
    const rejected = expect(task).rejects.toThrow();
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
  });
  it("无数据 45 秒后中止当前读取并恢复，注释心跳会续期", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start: (value) => {
        stream = value;
      },
      cancel,
    });
    const task = subscribeRun({
      conversationId: "c",
      runId: "r",
      signal: controller.signal,
      open: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      snapshot: async () => ({ ...completed, status: "running", sequence: 0 }),
      onEvent: vi.fn(),
      onSnapshot: vi.fn(),
    });
    const rejected = expect(task).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(40000);
    stream.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
    await vi.advanceTimersByTimeAsync(40000);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancel).toHaveBeenCalledOnce();
    controller.abort();
    await rejected;
  });
  it("刷新时即使快照已经完成，也从零回放正文，再按终态结束", async () => {
    const onEvent = vi.fn();
    const open = vi.fn<(cursor: number, signal: AbortSignal) => Promise<Response>>(async () =>
      response([final, end]),
    );
    const snapshot = vi.fn(async () => completed);
    await subscribeRun({
      conversationId: "c",
      runId: "r",
      signal: new AbortController().signal,
      open,
      snapshot,
      onEvent,
      onSnapshot: vi.fn(),
    });
    expect(open.mock.calls[0]?.[0]).toBe(0);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "final_answer",
      "run_completed",
    ]);
    expect(snapshot).toHaveBeenCalled();
  });

  it("断流后先复核快照，以已处理序号重连，重复帧不重复显示", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    let opened = 0;
    const open = vi.fn<(cursor: number, signal: AbortSignal) => Promise<Response>>(async () =>
      response(++opened === 1 ? [final] : [final, end]),
    );
    const snapshot = vi.fn(async () =>
      opened > 1 ? completed : { ...completed, status: "running" as const, sequence: 1 },
    );
    const task = subscribeRun({
      conversationId: "c",
      runId: "r",
      signal: new AbortController().signal,
      open,
      snapshot,
      onEvent,
      onSnapshot: vi.fn(),
    });
    await vi.runAllTimersAsync();
    await task;
    expect(open.mock.calls.map(([cursor]) => cursor)).toEqual([0, 1]);
    expect(onEvent.mock.calls.map(([event]) => event.sequence)).toEqual([1, 2]);
  });

  it("权限复核拒绝时立即报告，不能继续打开旧运行事件流", async () => {
    const open = vi.fn();
    const snapshot = vi.fn(async () => {
      throw new ApiError("暂无访问权限", 403, "FORBIDDEN");
    });
    await expect(
      subscribeRun({
        conversationId: "c",
        runId: "r",
        signal: new AbortController().signal,
        open,
        snapshot,
        onEvent: vi.fn(),
        onSnapshot: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(open).not.toHaveBeenCalled();
  });

  it("持续网络失败采用有界退避，五次重试后结束并允许用户手动恢复", async () => {
    vi.useFakeTimers();
    const open = vi.fn(async () => {
      throw new TypeError("断网");
    });
    const task = subscribeRun({
      conversationId: "c",
      runId: "r",
      signal: new AbortController().signal,
      open,
      snapshot: async () => ({ ...completed, status: "running", sequence: 0 }),
      onEvent: vi.fn(),
      onSnapshot: vi.fn(),
    });
    const rejected = expect(task).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejected;
    expect(open).toHaveBeenCalledTimes(6);
  });

  it("损坏数据不自动跳过重连；显示层尚未成功应用时也不能继续", async () => {
    const open = vi.fn(
      async () =>
        new Response("id: 1\nevent: progress\ndata: broken\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await expect(
      subscribeRun({
        conversationId: "c",
        runId: "r",
        signal: new AbortController().signal,
        open,
        snapshot: async () => completed,
        onEvent: vi.fn(),
        onSnapshot: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
    const apply = vi.fn(() => {
      throw new Error("界面应用失败");
    });
    await expect(
      subscribeRun({
        conversationId: "c",
        runId: "r",
        signal: new AbortController().signal,
        open: async () => response([final, end]),
        snapshot: async () => completed,
        onEvent: apply,
        onSnapshot: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
