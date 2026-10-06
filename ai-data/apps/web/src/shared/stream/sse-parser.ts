import { sseEventSchema } from "@ai-data/contracts";
import type { SseEvent } from "@ai-data/contracts";
import { ApiError } from "../http/api-error";
import type { RunScope, SseFrame } from "./stream-types";

/** 帧预算涵盖正文与表格样本，避免异常流持续堆积内存。 */
const maxFrameBytes = 1024 * 1024;
function protocolError(): ApiError {
  return new ApiError("事件内容不完整或与当前运行不一致，请重新连接", 0, "STREAM_PROTOCOL_ERROR");
}
/** 增量处理 UTF-8 和 CRLF/LF；完整空行帧才交给业务层。 */
function createSseParser(onFrame: (frame: SseFrame) => void) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let buffer = "";
  let id = "";
  let event = "";
  let data: string[] = [];
  let size = 0;
  function line(value: string) {
    size += encoder.encode(value).length + 1;
    if (size > maxFrameBytes) throw protocolError();
    if (!value) {
      if (data.length) onFrame({ id, event: event || "message", data: data.join("\n") });
      id = "";
      event = "";
      data = [];
      size = 0;
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const name = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (name === "data") data.push(content);
    else if (name === "event") event = content;
    else if (name === "id") id = content;
  }
  function drain(final = false) {
    let start = 0;
    for (let index = 0; index < buffer.length; index++) {
      const character = buffer[index];
      if (character !== "\r" && character !== "\n") continue;
      if (character === "\r" && index === buffer.length - 1 && !final) break;
      line(buffer.slice(start, index));
      if (character === "\r" && buffer[index + 1] === "\n") index++;
      start = index + 1;
    }
    buffer = buffer.slice(start);
    if (size + encoder.encode(buffer).length > maxFrameBytes) throw protocolError();
  }
  return {
    push(chunk: Uint8Array) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
      } catch {
        throw protocolError();
      }
      drain();
    },
    finish() {
      try {
        buffer += decoder.decode();
      } catch {
        throw protocolError();
      }
      drain(true);
      if (buffer || data.length || id || event) throw protocolError();
    },
  };
}
/** 重复事件仍需校验归属；只有连续完整事件允许推进游标。 */
function readRunEvent(frame: SseFrame, scope: RunScope): SseEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch {
    throw protocolError();
  }
  const parsed = sseEventSchema.safeParse(value);
  if (!parsed.success || !/^\d+$/.test(frame.id)) throw protocolError();
  const event = parsed.data;
  if (
    event.type !== frame.event ||
    Number(frame.id) !== event.sequence ||
    event.conversation_id !== scope.conversationId ||
    event.analysis_run_id !== scope.runId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.sequence > 2147483647
  )
    throw protocolError();
  if (
    event.type === "table" &&
    (event.rows.length > 100 ||
      new TextEncoder().encode(JSON.stringify({ columns: event.columns, rows: event.rows }))
        .length >
        256 * 1024)
  )
    throw protocolError();
  if (event.sequence <= scope.cursor) return null;
  if (event.sequence !== scope.cursor + 1) throw protocolError();
  return event;
}
export { createSseParser, readRunEvent, protocolError };
