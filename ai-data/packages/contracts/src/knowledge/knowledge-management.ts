import { z } from "zod";
import {
  knowledgeCandidateSchema,
  knowledgeContentSchema,
  publishedKnowledgeSchema,
} from "./knowledge";
import { dateTimeSchema } from "../shared/data-values";
import { memoryScopeSchema, memorySourceSchema } from "../memory/memory-common";
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
/** 管理页同时读取启停状态、最新发布与实际生效版本；内容仍由 API 授权。 */
const knowledgeManagementRecordSchema = z
  .object({
    knowledge_id: id,
    enabled: z.boolean(),
    latest: publishedKnowledgeSchema,
    current: publishedKnowledgeSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.knowledge_id !== record.latest.knowledge_id ||
      (record.current &&
        (record.current.knowledge_id !== record.knowledge_id ||
          record.current.organization_id !== record.latest.organization_id ||
          record.current.version > record.latest.version)) ||
      (!record.enabled && record.current)
    )
      context.addIssue({ code: "custom", message: "知识管理版本归属或启停状态不一致" });
  });
/** 管理员搜索同组织有效负责人，数量有上限并拒绝额外归属字段。 */
const knowledgeOwnerOptionsInputSchema = z
  .object({
    keyword: z.string().trim().max(100).default(""),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
/** 负责人候选只返回选择所需的公开账号标识。 */
const knowledgeOwnerOptionSchema = z
  .object({ user_id: id, username: z.string().min(1), display_name: z.string() })
  .strict();
export {
  updateKnowledgeSchema,
  rollbackKnowledgeSchema,
  knowledgeSourceRecordSchema,
  knowledgeReviewRecordSchema,
  knowledgeManagementRecordSchema,
  knowledgeOwnerOptionsInputSchema,
  knowledgeOwnerOptionSchema,
};
