import type { z } from "zod";
import type {
  knowledgeContentSchema,
  knowledgeCandidateInputSchema,
  knowledgeCandidateSchema,
  publishedKnowledgeSchema,
  knowledgeReviewInputSchema,
  knowledgePublishInputSchema,
} from "./knowledge";
/** 企业规则或指标定义。 */
type KnowledgeContent = z.infer<typeof knowledgeContentSchema>;
/** 企业候选提交输入。 */
type KnowledgeCandidateInput = z.infer<typeof knowledgeCandidateInputSchema>;
/** 带归属和审核状态的候选版本。 */
type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
/** 当前或历史正式知识版本。 */
type PublishedKnowledge = z.infer<typeof publishedKnowledgeSchema>;
/** 固定候选版本的审核输入。 */
type KnowledgeReviewInput = z.infer<typeof knowledgeReviewInputSchema>;
/** 正式发布输入。 */
type KnowledgePublishInput = z.infer<typeof knowledgePublishInputSchema>;
export type {
  KnowledgeContent,
  KnowledgeCandidateInput,
  KnowledgeCandidate,
  PublishedKnowledge,
  KnowledgeReviewInput,
  KnowledgePublishInput,
};
