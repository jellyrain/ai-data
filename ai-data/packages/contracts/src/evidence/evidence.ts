import { z } from "zod";
import { queryDslSchema } from "../query/query-dsl";
import { queryResultSchema } from "../query/query-result";
import { queryAccessContextSchema } from "../access/access-context";
import { dateTimeSchema } from "../shared/data-values";

const id = z.string().min(1).max(128);
/** 保存执行前输入、最终授权 DSL、输出策略及结果，供历史引用重新校验完整数据范围。 */
const queryEvidenceSchema = z
  .object({
    evidence_id: id,
    tool_call_id: id,
    analysis_run_id: id,
    organization_id: id,
    user_id: id,
    created_at: dateTimeSchema,
    requested_query: queryDslSchema,
    authorized_query: queryDslSchema,
    output_masks: queryAccessContextSchema.shape.output_masks,
    metric: z.object({ metric_id: id, version: z.number().int().positive() }).strict().optional(),
    result: queryResultSchema,
  })
  .strict();
/** 分析步骤及假设引用稳定证据标识，区分观测、已验证结论和待验证假设。 */
const analysisStepSchema = z
  .object({
    step_id: id,
    analysis_run_id: id,
    title: z.string().min(1).max(1000),
    hypothesis: z.string().max(8000).optional(),
    conclusion: z.string().max(16000).optional(),
    status: z.enum(["planned", "supported", "rejected", "inconclusive"]),
    evidence_ids: z.array(id).max(1000),
  })
  .strict()
  .refine(
    (step) => !["supported", "rejected"].includes(step.status) || step.evidence_ids.length > 0,
    "已验证结论必须有证据",
  );

export { queryEvidenceSchema, analysisStepSchema };
