import type { z } from "zod";
import type {
  updateKnowledgeSchema,
  rollbackKnowledgeSchema,
  knowledgeSourceRecordSchema,
  knowledgeReviewRecordSchema,
  knowledgeManagementRecordSchema,
  knowledgeOwnerOptionsInputSchema,
  knowledgeOwnerOptionSchema,
} from "./knowledge-management";
/** 绑定固定版本的候选编辑请求。 */
type UpdateKnowledge = z.infer<typeof updateKnowledgeSchema>;
/** 创建新的正式版本的回滚请求。 */
type RollbackKnowledge = z.infer<typeof rollbackKnowledgeSchema>;
/** 候选来源与提交账号。 */
type KnowledgeSourceRecord = z.infer<typeof knowledgeSourceRecordSchema>;
/** 审核决定及被审核的固定快照。 */
type KnowledgeReviewRecord = z.infer<typeof knowledgeReviewRecordSchema>;
/** 管理页的启停状态及发布、生效版本。 */
type KnowledgeManagementRecord = z.infer<typeof knowledgeManagementRecordSchema>;
/** 有界负责人搜索输入。 */
type KnowledgeOwnerOptionsInput = z.infer<typeof knowledgeOwnerOptionsInputSchema>;
/** 本组织有效负责人选项。 */
type KnowledgeOwnerOption = z.infer<typeof knowledgeOwnerOptionSchema>;
export type {
  UpdateKnowledge,
  RollbackKnowledge,
  KnowledgeSourceRecord,
  KnowledgeReviewRecord,
  KnowledgeManagementRecord,
  KnowledgeOwnerOptionsInput,
  KnowledgeOwnerOption,
};
