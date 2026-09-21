import { z } from "zod";
import {
  dateTimeSchema,
  knowledgeCandidateSchema,
  knowledgeContentSchema,
  memoryScopeSchema,
  memorySourceSchema,
  publishedKnowledgeSchema,
} from "@ai-data/contracts";
const id = z.string().min(1).max(128);
/** 编辑提交固定候选版本；新内容按同一适用范围重新审核。 */
const updateKnowledgeSchema = z
  .object({
    expected_version: z.number().int().positive(),
    content: knowledgeContentSchema,
    scope: memoryScopeSchema,
  })
  .strict();
/** 回滚引用历史正式版本，并校验调用方看到的最新版本和操作标识。 */
const rollbackKnowledgeSchema = z
  .object({
    version: z.number().int().positive(),
    expected_version: z.number().int().positive(),
    effective_at: dateTimeSchema,
    idempotency_key: id,
  })
  .strict();
/** 来源归属独立保存；服务逐条验证引用后才向访问者返回。 */
const knowledgeSourceRecordSchema = z.object({ user_id: id, source: memorySourceSchema }).strict();
/** 审核保存当时完整候选快照，内容修改后仍可追溯原审核。 */
const knowledgeReviewRecordSchema = z
  .object({
    review_id: id,
    candidate: knowledgeCandidateSchema,
    reviewed_by: id,
    decision: z.enum(["approve", "reject"]),
    comment: z.string().min(1).max(2000),
    reviewed_at: dateTimeSchema,
  })
  .strict();
/** 幂等记录仅接受本领域的明确结果类型。 */
const knowledgeOperationSchema = z
  .object({
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    result: z.union([knowledgeCandidateSchema, publishedKnowledgeSchema]),
  })
  .strict();
export {
  updateKnowledgeSchema,
  rollbackKnowledgeSchema,
  knowledgeSourceRecordSchema,
  knowledgeReviewRecordSchema,
  knowledgeOperationSchema,
};
