import { z } from "zod";

const id = z.string().min(1).max(128);
/** 记忆的业务适用范围；对象必须同时指定所属数据源，组织由认证上下文确定。 */
const memoryScopeSchema = z
  .object({
    source_id: id.optional(),
    object_id: z.string().min(1).max(256).optional(),
    metric_id: id.optional(),
  })
  .strict()
  .refine((value) => !value.object_id || Boolean(value.source_id), "对象范围必须指定数据源");
/** 保存来源引用，具体归属和证据访问权由 API 复核；手动设置可以没有会话来源。 */
const memorySourceSchema = z
  .object({
    conversation_id: id.optional(),
    analysis_run_id: id.optional(),
    message_id: id.optional(),
    evidence_ids: z.array(id).max(30).default([]),
  })
  .strict();
export { memoryScopeSchema, memorySourceSchema };
