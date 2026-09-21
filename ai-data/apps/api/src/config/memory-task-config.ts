import { z } from "zod";

/** 后台预算独立于模型；事务处理时限必须短于租约，留出提交检查时间。 */
const memoryTaskConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    concurrency: z.number().int().min(1).max(4).default(1),
    poll_ms: z.number().int().min(100).max(60000).default(2000),
    timeout_ms: z.number().int().min(1000).max(60000).default(10000),
    lease_ms: z.number().int().min(5000).max(120000).default(30000),
    max_attempts: z.number().int().min(1).max(10).default(3),
  })
  .strict()
  .refine(
    (value) => value.lease_ms >= value.timeout_ms + 5000,
    "记忆任务租约应比处理时限至少多 5 秒",
  );

export { memoryTaskConfigSchema };
