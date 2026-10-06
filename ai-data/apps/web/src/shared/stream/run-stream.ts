import { analysisRunSchema } from "@ai-data/contracts";
import { ApiError } from "../http/api-error";
import { createSseParser, protocolError, readRunEvent } from "./sse-parser";
import type { RunSubscription } from "./stream-types";

/** 业务终态由服务端决定，最终正文事件本身不会结束运行。 */
function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** 页面生命周期内的订阅；重连先复核授权，游标始终在成功应用之后推进。 */
async function subscribeRun(options: RunSubscription): Promise<void> {
  let cursor = options.initialCursor ?? 0;
  let failures = 0;
  const backoff = [1000, 2000, 4000, 8000, 15000];
  async function snapshot() {
    const state = analysisRunSchema.parse(await options.snapshot(options.signal));
    options.signal.throwIfAborted();
    if (
      state.analysis_run_id !== options.runId ||
      state.conversation_id !== options.conversationId ||
      state.sequence < cursor
    )
      throw protocolError();
    options.onSnapshot(state);
    return state;
  }
  while (true) {
    options.signal.throwIfAborted();
    const connection = new AbortController();
    const signal = AbortSignal.any([options.signal, connection.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => {
      void reader?.cancel().catch(() => {});
    };
    try {
      const state = await snapshot();
      if (isTerminal(state.status) && cursor >= state.sequence) {
        options.onConnection?.("complete");
        return;
      }
      options.onConnection?.(failures ? "reconnecting" : "connecting");
      timer = setTimeout(() => connection.abort(new Error("连接超时")), 20_000);
      const response = await options.open(cursor, signal);
      signal.throwIfAborted();
      clearTimeout(timer);
      if (!response.ok) throw new ApiError("无法连接事件流", response.status);
      if (
        !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
        !response.body
      )
        throw protocolError();
      reader = response.body.getReader();
      signal.addEventListener("abort", cancelReader, { once: true });
      options.onConnection?.("live");
      const parser = createSseParser((frame) => {
        signal.throwIfAborted();
        const event = readRunEvent(frame, {
          conversationId: options.conversationId,
          runId: options.runId,
          cursor,
        });
        if (!event) return;
        try {
          options.onEvent(event);
        } catch {
          throw protocolError();
        }
        cursor = event.sequence;
        failures = 0;
      });
      while (true) {
        timer = setTimeout(() => connection.abort(new Error("连接长时间未收到数据")), 45_000);
        const chunk = await reader.read();
        clearTimeout(timer);
        signal.throwIfAborted();
        if (chunk.done) break;
        parser.push(chunk.value);
      }
      parser.finish();
      const current = await snapshot();
      if (isTerminal(current.status) && cursor >= current.sequence) {
        options.onConnection?.("complete");
        return;
      }
    } catch (error) {
      options.signal.throwIfAborted();
      if (
        error instanceof ApiError &&
        (error.code === "STREAM_PROTOCOL_ERROR" || [400, 401, 403, 404].includes(error.status))
      )
        throw error;
      if (error instanceof Error && error.name === "ZodError") throw protocolError();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelReader);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      connection.abort();
    }
    if (failures >= backoff.length)
      throw new ApiError("连接中断，请点击重新连接继续查看", 0, "STREAM_DISCONNECTED");
    options.onConnection?.("reconnecting");
    await delay(backoff[failures++]!, options.signal);
  }
}
export { subscribeRun, isTerminal };
