import type { z } from "zod";
import type { sseEventSchema } from "./sse-events";

/** API 推送给 Web 的全部 SSE 事件联合类型。 */
type SseEvent = z.infer<typeof sseEventSchema>;

export type { SseEvent };
