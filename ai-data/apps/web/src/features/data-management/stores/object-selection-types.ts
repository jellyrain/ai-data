import type { z } from "zod";
import type { sourceObjectSelectionRequestSchema } from "@ai-data/contracts";
/** 编辑副本保留未改动对象，保存时提交完整集合。 */
type ObjectSelection = z.infer<typeof sourceObjectSelectionRequestSchema>["objects"][number];
export type { ObjectSelection };
