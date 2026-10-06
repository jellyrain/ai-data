import { z } from "zod";
import { reportNarrativeSchema } from "@ai-data/contracts";
/** 说明接口返回固定执行下的已保存文字，以及独立运行的定位回执。 */
const narrativeListSchema = z.object({ items: z.array(reportNarrativeSchema) }).strict();
const narrativeReceiptSchema = z
  .object({
    conversation_id: z.string().min(1).max(128),
    analysis_run_id: z.string().min(1).max(128),
  })
  .strict();
export { narrativeListSchema, narrativeReceiptSchema };
