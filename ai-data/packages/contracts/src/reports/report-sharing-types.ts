import type { z } from "zod";
import type {
  reportShareCandidateSchema,
  reportShareMemberSchema,
  reportSharingSchema,
  reportShareCandidatesInputSchema,
  reportShareCandidatesSchema,
} from "./report-sharing";

/** 分享候选成员的最少公开资料。 */
type ReportShareCandidate = z.infer<typeof reportShareCandidateSchema>;
/** 已选成员的当前账号状态。 */
type ReportShareMember = z.infer<typeof reportShareMemberSchema>;
/** 作者读取的当前分享名单及保存基准。 */
type ReportSharing = z.infer<typeof reportSharingSchema>;
/** 成员检索和稳定分页参数。 */
type ReportShareCandidatesInput = z.infer<typeof reportShareCandidatesInputSchema>;
/** 已授权候选成员页。 */
type ReportShareCandidates = z.infer<typeof reportShareCandidatesSchema>;

export type {
  ReportShareCandidate,
  ReportShareMember,
  ReportSharing,
  ReportShareCandidatesInput,
  ReportShareCandidates,
};
