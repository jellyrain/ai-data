import { z } from "zod";

/** 持久化工具摘要用于关联运行、证据和失败，不保存查询结果行。 */
const toolAuditSchema = z
  .object({
    tool_call_id: z.string().min(1).max(128),
    tool_name: z.string().min(1).max(128),
    input_hash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["running", "completed", "failed"]),
    duration_ms: z.number().int().nonnegative(),
    evidence_ids: z.array(z.string().min(1)).max(1000).default([]),
    error_code: z.string().max(128).optional(),
  })
  .strict();
export { toolAuditSchema };
