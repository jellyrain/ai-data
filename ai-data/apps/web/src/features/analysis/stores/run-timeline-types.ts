import type { SseEvent } from "@ai-data/contracts";

/** 每个条目首次出现的位置固定，消息完成和工具结果只更新对应条目。 */
type RunTimelineItem =
  | {
      kind: "message";
      key: string;
      content: string;
      completed: boolean;
      /** 仅服务端 final_answer 事件确认已提交的最终回答。 */
      final?: boolean;
      phase?: "commentary" | "final_answer";
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      /** 保留服务端调用标识，供依据面板精确关联。 */
      callId?: string;
      input?: string;
      output?: string;
      success?: boolean;
      durationMs?: number;
    }
  | { kind: "table"; key: string; event: Extract<SseEvent, { type: "table" }> }
  | { kind: "clarification"; key: string; question: string; answer?: string }
  | { kind: "progress"; key: string; content: string };
export type { RunTimelineItem };
