import type { z } from "zod";
import type { memoryIntentSchema, memoryEventSummarySchema } from "./memory-event";

type MemoryIntent = z.infer<typeof memoryIntentSchema>;
type MemoryEventSummary = z.infer<typeof memoryEventSummarySchema>;

export type { MemoryIntent, MemoryEventSummary };
