import type {
  ReportDefinitionVersion,
  ReportShareCandidate,
  ReportShareMember,
  ReportShareCandidatesInput,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";

/** 既有领域读取完成权限检查后，用于管理名单的头记录摘要。 */
type ReportSharingHead = Pick<
  ReportDefinitionVersion,
  "organization_id" | "user_id" | "version" | "shared_with"
>;
/** 成员查询始终受组织限制；候选额外一条由服务用于判断下一页。 */
interface ReportSharingRepository {
  members(organizationId: string, userIds: string[]): Promise<ReportShareMember[]>;
  candidates(
    organizationId: string,
    ownerUserId: string,
    input: ReportShareCandidatesInput,
  ): Promise<ReportShareCandidate[]>;
}
/** 复用定义和快照读取授权，不向浏览器开放管理用户接口。 */
type ReportSharingDependencies = {
  definitions: { get(context: AuthContext, id: string): Promise<ReportSharingHead> };
  reports: { get(context: AuthContext, id: string): Promise<ReportSharingHead> };
  repository: ReportSharingRepository;
};

export type { ReportSharingHead, ReportSharingRepository, ReportSharingDependencies };
