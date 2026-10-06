import { describe, expect, it } from "vitest";
import { createSseParser, readRunEvent } from "../../../src/shared/stream/sse-parser";

const event = {
  type: "progress",
  conversation_id: "conversation-a",
  analysis_run_id: "run-a",
  sequence: 1,
  message: "正在查询门诊数据",
};
const scope = { conversationId: "conversation-a", runId: "run-a", cursor: 0 };
const frame = { id: "1", event: "progress", data: JSON.stringify(event) };

describe("运行事件增量解析", () => {
  it("逐字节 UTF-8、跨块 CRLF 与多行 data 只在完整帧后交付", () => {
    const frames: unknown[] = [];
    const parser = createSseParser((value) => frames.push(value));
    const wire = new TextEncoder().encode(
      ': keep-alive\r\n\r\nid: 1\r\nevent: progress\r\ndata: {"说明":\r\ndata: "门诊"}\r\n\r\n',
    );
    for (const byte of wire) parser.push(new Uint8Array([byte]));
    parser.finish();
    expect(frames).toEqual([{ id: "1", event: "progress", data: '{"说明":\n"门诊"}' }]);
  });

  it("LF 连续帧和注释心跳不产生虚构业务事件", () => {
    const frames: unknown[] = [];
    const parser = createSseParser((value) => frames.push(value));
    parser.push(
      new TextEncoder().encode(
        `: keep-alive\n\nid: 1\nevent: progress\ndata: ${frame.data}\n\nid: 2\nevent: run_completed\ndata: {}\n\n`,
      ),
    );
    parser.finish();
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(frame);
  });

  it("EOF 的半帧和超过 1 MiB 的帧报告协议错误", () => {
    const parser = createSseParser(() => undefined);
    parser.push(new TextEncoder().encode('id: 1\ndata: {"未完":'));
    expect(() => parser.finish()).toThrow();
    const oversized = createSseParser(() => undefined);
    expect(() =>
      oversized.push(new TextEncoder().encode(`data: ${"x".repeat(1024 * 1024)}`)),
    ).toThrow();
  });

  it("归属与合同校验通过才接受事件，重复事件不再次应用", () => {
    expect(readRunEvent(frame, scope)).toEqual(event);
    expect(readRunEvent(frame, { ...scope, cursor: 1 })).toBeNull();
  });

  it.each([
    { ...frame, id: "2" },
    { ...frame, id: "1x" },
    { ...frame, event: "run_completed" },
    { ...frame, data: "not-json" },
    { ...frame, data: JSON.stringify({ ...event, conversation_id: "other" }) },
    { ...frame, data: JSON.stringify({ ...event, analysis_run_id: "other" }) },
    { ...frame, data: JSON.stringify({ ...event, unexpected: true }) },
  ])("帧 ID、类型、归属或结构损坏时停止推进游标：%j", (invalid) => {
    expect(() => readRunEvent(invalid, scope)).toThrow();
  });

  it("事件序号存在缺口时拒绝跳过尚未重建的内容", () => {
    expect(() =>
      readRunEvent({ ...frame, id: "3", data: JSON.stringify({ ...event, sequence: 3 }) }, scope),
    ).toThrow();
  });
});
