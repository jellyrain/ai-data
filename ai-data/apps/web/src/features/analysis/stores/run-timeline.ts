import type { SseEvent } from "@ai-data/contracts";
import type { RunTimelineItem } from "./run-timeline-types";

/** 以提交顺序重建可恢复时间线；同名工具按调用标识和租约代次隔离。 */
function projectRunTimeline(events: readonly SseEvent[]): RunTimelineItem[] {
  const items: RunTimelineItem[] = [];
  const messages = new Map<string, Extract<RunTimelineItem, { kind: "message" }>>();
  const tools = new Map<string, Extract<RunTimelineItem, { kind: "tool" }>>();
  const questions = new Map<
    string,
    {
      item: Extract<RunTimelineItem, { kind: "clarification" }>;
      options: { id: string; label: string }[];
    }
  >();
  const seen = new Set<number>();
  for (const event of events) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    const key = `${event.lease_epoch ?? 0}:${event.sequence}`;
    if (event.type === "assistant_message" || event.type === "final_answer") {
      const id = event.message_id ? `${event.lease_epoch ?? 0}:message:${event.message_id}` : key;
      let item = messages.get(id);
      if (!item) {
        item = { kind: "message", key: id, content: "", completed: false };
        messages.set(id, item);
        items.push(item);
      }
      if (event.type === "final_answer") {
        item.content = event.content;
        item.completed = true;
        item.phase = "final_answer";
        item.final = true;
      } else {
        if (event.phase) item.phase = event.phase;
        if (event.status === "completed") {
          item.content = event.content;
          item.completed = true;
        } else if (event.status === "delta" && !item.completed) item.content += event.content;
      }
    } else if (event.type === "tool_call" || event.type === "tool_result") {
      const id = event.tool_call_id ? `${event.lease_epoch ?? 0}:tool:${event.tool_call_id}` : key;
      let item = tools.get(id);
      if (!item) {
        item = { kind: "tool", key: id, name: event.tool_name };
        tools.set(id, item);
        items.push(item);
      }
      if (event.type === "tool_call") item.input = event.input_summary;
      else {
        item.output = event.output_summary;
        item.success = event.success;
      }
    } else if (event.type === "table") items.push({ kind: "table", key, event });
    else if (event.type === "thinking" || event.type === "progress")
      items.push({
        kind: "progress",
        key,
        content: event.type === "thinking" ? event.content : event.message,
      });
    else if (event.type === "clarification" && event.clarification_id) {
      const item: Extract<RunTimelineItem, { kind: "clarification" }> = {
        kind: "clarification",
        key,
        question: event.question,
      };
      questions.set(event.clarification_id, { item, options: event.options });
      items.push(item);
    } else if (event.type === "clarification_answered") {
      const question = questions.get(event.clarification_id);
      if (question)
        question.item.answer =
          event.custom_input ??
          question.options.find((option) => option.id === event.option_id)?.label ??
          event.option_id;
    }
  }
  return items;
}
export { projectRunTimeline };
