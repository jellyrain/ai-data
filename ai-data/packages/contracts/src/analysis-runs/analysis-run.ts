import { z } from "zod";
import { dateTimeSchema } from "../shared/data-values";

const id = z.string().min(1).max(128);
/** 运行终态稳定；澄清等待仍占用当前会话的活跃运行。 */
const analysisRunStatusSchema = z.enum([
  "created",
  "running",
  "waiting_clarification",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
/** 消息幂等键作用于当前会话；重复键必须对应完全相同的问题。 */
const submitMessageSchema = z
  .object({ content: z.string().trim().min(1).max(64000), idempotency_key: id })
  .strict();
/** 待答问题与稳定选项随原运行持久化。 */
const clarificationSchema = z
  .object({
    clarification_id: id,
    /** API 绑定的个人偏好确认；模型普通澄清参数不开放该字段。 */
    preference_confirmation_id: id.optional(),
    question: z.string().min(1).max(8000),
    options: z.array(z.object({ id, label: z.string().min(1).max(2000) }).strict()).max(100),
    allow_custom_input: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.options.map((option) => option.id)).size !== value.options.length)
      context.addIssue({ code: "custom", message: "澄清选项标识不能重复" });
    if (!value.options.length && !value.allow_custom_input)
      context.addIssue({ code: "custom", message: "澄清问题必须有可提交的回答" });
  });
/** 一次有效澄清回答；选项存在性由运行服务按当前待答问题校验。 */
const clarificationAnswerSchema = z
  .object({
    clarification_id: id,
    idempotency_key: id,
    option_id: id.optional(),
    custom_input: z.string().trim().min(1).max(8000).optional(),
  })
  .strict()
  .refine(
    (value) => (value.option_id === undefined) !== (value.custom_input === undefined),
    "选择选项或提供自定义回答",
  );
/** 当前执行器须同时持有租约及对应代次，过期执行器不能提交结果。 */
const runLeaseSchema = z
  .object({ owner: id, epoch: z.number().int().positive(), expires_at: dateTimeSchema })
  .strict();
/** 可恢复运行快照。事件序号与运行快照在同一事务中推进。 */
const analysisRunSchema = z
  .object({
    analysis_run_id: id,
    conversation_id: id,
    organization_id: id,
    user_id: id,
    /** 实际运行绑定的 Agent 版本；迁移前尚未装配的历史记录省略这两个字段。 */
    agent_id: id.optional(),
    agent_version: z.number().int().positive().optional(),
    status: analysisRunStatusSchema,
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
    lease_epoch: z.number().int().nonnegative(),
    lease: runLeaseSchema.nullable(),
    sequence: z.number().int().nonnegative(),
    clarification: clarificationSchema.nullable(),
    evidence_ids: z.array(id).max(1000),
    error: z
      .object({ code: id, message: z.string().min(1).max(2000) })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) => (value.agent_id === undefined) === (value.agent_version === undefined),
    "Agent 标识与版本必须同时提供",
  );

export {
  analysisRunStatusSchema,
  submitMessageSchema,
  clarificationSchema,
  clarificationAnswerSchema,
  runLeaseSchema,
  analysisRunSchema,
};
