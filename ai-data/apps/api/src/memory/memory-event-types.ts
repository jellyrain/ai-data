import type { z } from "zod";
import type { memoryEventRecordSchema } from "./memory-event-record";

type MemoryEvent = z.infer<typeof memoryEventRecordSchema>;

export type { MemoryEvent };
