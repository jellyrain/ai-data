import { z } from "zod";
import { dateSchema } from "../shared/data-values";
import { publishedKnowledgeSchema } from "../knowledge/knowledge";
import { preferenceConfirmationSchema, userPreferenceSchema } from "./user-preference";

/** 单轮实际使用的账号默认、正式知识及解析日期；随运行租约保存用于追溯。 */
const memoryContextSchema = z
  .object({
    rules: z.string().min(1).max(2000),
    preferences: z
      .array(
        userPreferenceSchema.safeExtend({
          resolved_time_range: z.object({ start: dateSchema, end: dateSchema }).strict().optional(),
        }),
      )
      .max(30),
    disabled_keys: z.array(z.string().min(1).max(128)).max(200),
    pending_confirmations: z.array(preferenceConfirmationSchema).max(5),
    knowledge: z.array(publishedKnowledgeSchema).max(30),
  })
  .strict();

export { memoryContextSchema };
