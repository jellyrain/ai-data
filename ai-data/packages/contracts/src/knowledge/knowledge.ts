import { z } from "zod";
import { metricDefinitionSchema } from "../metrics/metric";
import { dateTimeSchema } from "../shared/data-values";
import { memoryScopeSchema, memorySourceSchema } from "../memory/memory-common";
const id = z.string().min(1).max(128);
/** 企业知识包括固定结构的指标和业务规则说明，其他内容在输入边界拒绝。 */
const knowledgeContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metric"), definition: metricDefinitionSchema }).strict(),
  z
    .object({
      type: z.literal("business_rule"),
      title: z.string().min(1).max(256),
      body: z.string().min(1).max(16000),
    })
    .strict(),
  /** 组织模板候选固定定义版本及内容摘要，审核期间编辑原报表不会替换候选内容。 */
  z
    .object({
      type: z.literal("report_template"),
      report_id: id,
      definition_version: z.number().int().positive(),
      definition_hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
/** 提交者只能指定内容与适用范围，审核归属和状态由服务决定。 */
const knowledgeCandidateInputSchema = z
  .object({
    idempotency_key: id,
    knowledge_id: id.optional(),
    content: knowledgeContentSchema,
    scope: memoryScopeSchema,
    source: memorySourceSchema.optional(),
  })
  .strict();
/** 候选版本绑定审核内容摘要，内容更新后重新进入待审状态。 */
const knowledgeCandidateSchema = z
  .object({
    candidate_id: id,
    organization_id: id,
    knowledge_id: id,
    version: z.number().int().positive(),
    content: knowledgeContentSchema,
    scope: memoryScopeSchema,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["pending", "approved", "rejected", "withdrawn", "published"]),
    created_by: id,
    owner_id: id.nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .strict();
/** 发布版本不可改写，启停状态由知识头记录独立管理。 */
const publishedKnowledgeSchema = z
  .object({
    organization_id: id,
    knowledge_id: id,
    version: z.number().int().positive(),
    content: knowledgeContentSchema,
    scope: memoryScopeSchema,
    owner_id: id,
    published_by: id,
    published_at: dateTimeSchema,
    effective_at: dateTimeSchema,
    source_candidate_id: id,
    rollback_from_version: z.number().int().positive().optional(),
  })
  .strict();
/** 审核只针对调用方看到的候选版本。 */
const knowledgeReviewInputSchema = z
  .object({
    expected_version: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
    comment: z.string().min(1).max(2000),
  })
  .strict();
/** 发布要求固定候选版本，并显式指定东八区生效时间。 */
const knowledgePublishInputSchema = z
  .object({ expected_version: z.number().int().positive(), effective_at: dateTimeSchema })
  .strict();
export {
  knowledgeContentSchema,
  knowledgeCandidateInputSchema,
  knowledgeCandidateSchema,
  publishedKnowledgeSchema,
  knowledgeReviewInputSchema,
  knowledgePublishInputSchema,
};
