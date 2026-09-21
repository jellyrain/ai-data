import type { z } from "zod";
import type { memoryContextSchema } from "./memory-context";

type MemoryContext = z.infer<typeof memoryContextSchema>;

export type { MemoryContext };
