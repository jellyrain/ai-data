import type { AnalysisRunState, SseEvent } from "@ai-data/contracts";

/** 一条完整的 SSE 帧，尚未校验业务内容。 */
type SseFrame = { id: string; event: string; data: string };
/** 游标仅代表当前页面已应用的内容，与运行快照序号分开。 */
type RunScope = { conversationId: string; runId: string; cursor: number };
/** 认证和资源生命周期由调用者注入，订阅负责协议与重连。 */
type RunSubscription = {
  conversationId: string;
  runId: string;
  signal: AbortSignal;
  initialCursor?: number;
  open: (cursor: number, signal: AbortSignal) => Promise<Response>;
  snapshot: (signal: AbortSignal) => Promise<AnalysisRunState>;
  onEvent: (event: SseEvent) => void;
  onSnapshot: (snapshot: AnalysisRunState) => void;
  onConnection?: (state: "connecting" | "live" | "reconnecting" | "complete") => void;
};
export type { SseFrame, RunScope, RunSubscription };
