import { z } from "zod";
import { dateTimeSchema } from "../shared/data-values";
import { userPreferenceInputSchema } from "./user-preference";
import { memorySourceSchema } from "./memory-common";
import { knowledgeCandidateInputSchema } from "../knowledge/knowledge";

/** 对话产生的受控意图，成功完成运行后交给后台；拒绝未知内容与任意指令。 */
const memoryIntentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("query_habit"),
      preference: userPreferenceInputSchema.refine(
        (value) => value.value.type === "query_habit",
        "后台观察只接受查询习惯",
      ),
      source: memorySourceSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("knowledge_candidate"), candidate: knowledgeCandidateInputSchema })
    .strict(),
]);
/** 管理入口只返回状态和稳定错误码，意图正文及账号私有条件留在存储层。 */
const memoryEventSummarySchema = z
  .object({
    event_id: z.string().min(1).max(128),
    analysis_run_id: z.string().min(1).max(128),
    status: z.enum(["pending", "processing", "done", "failed"]),
    attempts: z.number().int().nonnegative(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
    last_error_code: z.string().min(1).max(128).nullable(),
  })
  .strict();

export { memoryIntentSchema, memoryEventSummarySchema };
