import { z } from "zod";
import { memoryIntentSchema, memoryEventSummarySchema } from "@ai-data/contracts";

/** 领取后的内部记录包含身份与租约代次；管理 API 只暴露 summary。 */
const memoryEventRecordSchema = memoryEventSummarySchema.extend({
  organization_id: z.string().min(1).max(128),
  user_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  intent_key: z.string().regex(/^[a-f0-9]{64}$/),
  intent: memoryIntentSchema,
  lease_owner: z.string().min(1).max(128),
  lease_epoch: z.number().int().positive(),
});

export { memoryEventRecordSchema };
