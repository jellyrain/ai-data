import { expect, it } from "vitest";
import type { SseEvent } from "@ai-data/contracts";
import { projectRunTimeline } from "../../../src/features/analysis/stores/run-timeline";

const event = (sequence: number, fields: Record<string, unknown>) =>
  ({
    sequence,
    conversation_id: "conversation",
    analysis_run_id: "run",
    lease_epoch: 1,
    ...fields,
  }) as SseEvent;
it("文字与同名工具交错，重复回放去重，最终校准只更新原消息", () => {
  const events = [
    event(1, { type: "assistant_message", message_id: "a", status: "delta", content: "先查询" }),
    event(2, { type: "tool_call", tool_call_id: "one", tool_name: "query", input_summary: "一" }),
    event(3, { type: "assistant_message", message_id: "b", status: "delta", content: "查到了" }),
    event(4, { type: "tool_call", tool_call_id: "two", tool_name: "query", input_summary: "二" }),
    event(5, {
      type: "tool_result",
      tool_call_id: "two",
      tool_name: "query",
      success: false,
      output_summary: "失败",
    }),
    event(6, {
      type: "tool_result",
      tool_call_id: "one",
      tool_name: "query",
      success: true,
      output_summary: "完成",
    }),
    event(7, {
      type: "assistant_message",
      message_id: "b",
      status: "completed",
      content: "查到 7 人。",
    }),
    event(8, { type: "final_answer", message_id: "b", content: "查到 7 人。" }),
  ];
  const timeline = projectRunTimeline([...events, events[2]!]);
  expect(timeline.map((item) => item.kind)).toEqual(["message", "tool", "message", "tool"]);
  expect(timeline[1]).toMatchObject({ success: true, input: "一" });
  expect(timeline[3]).toMatchObject({ success: false, input: "二" });
  expect(timeline[2]).toMatchObject({ content: "查到 7 人。", completed: true, final: true });
  expect(projectRunTimeline(events)).toEqual(timeline);
});
it("模型的最终阶段标记仍属于过程，只有已提交答案成为最终结果", () => {
  const message = event(1, {
    type: "assistant_message",
    message_id: "a",
    status: "completed",
    content: "模型回答",
    phase: "final_answer",
  });
  expect(projectRunTimeline([message])[0]).not.toHaveProperty("final", true);
  expect(
    projectRunTimeline([
      message,
      event(2, { type: "final_answer", message_id: "a", content: "已提交回答" }),
    ])[0],
  ).toMatchObject({ final: true, content: "已提交回答" });
});
it("代次区分相同消息和工具 ID，旧答案与表格保持事件位置", () => {
  const timeline = projectRunTimeline([
    event(1, {
      type: "assistant_message",
      message_id: "a",
      status: "delta",
      content: "已停止片段",
    }),
    event(2, {
      type: "assistant_message",
      message_id: "a",
      status: "completed",
      content: "恢复回答",
      lease_epoch: 2,
    }),
    event(3, { type: "table", columns: [], rows: [] }),
    event(4, { type: "final_answer", content: "旧历史答案" }),
  ]);
  expect(timeline.map((item) => item.kind)).toEqual(["message", "message", "table", "message"]);
  expect(timeline[0]).toMatchObject({ content: "已停止片段", completed: false });
});
