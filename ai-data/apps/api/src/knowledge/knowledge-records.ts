import { z } from "zod";
import {
  knowledgeCandidateSchema,
  publishedKnowledgeSchema,
  updateKnowledgeSchema,
  rollbackKnowledgeSchema,
  knowledgeSourceRecordSchema,
  knowledgeReviewRecordSchema,
} from "@ai-data/contracts";
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
