import type { AnalysisArtifact, QueryEvidence, AnalysisRunState } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { ConversationMessage } from "../conversations/conversation-types";
import type { ReportDefinitionService } from "./report-definition-service";
import type { ReportService } from "./report-service";

/** 管理读取不依赖业务查询执行器。 */
interface ReportManagementRepository {
  listReportIds(
    organizationId: string,
    after: string | undefined,
    limit: number,
  ): Promise<string[]>;
  snapshotVersions(organizationId: string, reportId: string): Promise<number[]>;
  artifacts(organizationId: string, runId: string): Promise<AnalysisArtifact[]>;
}
/** 报表与会话导出仅聚合持久化记录，读取授权由领域服务负责。 */
type ReportManagementDependencies = {
  repository: ReportManagementRepository;
  reports: Pick<ReportService, "get" | "share">;
  definitions: Pick<ReportDefinitionService, "get" | "versions" | "share">;
  source(context: AuthContext, runId: string, requireOwner: boolean): Promise<QueryEvidence[]>;
  runs: {
    get(context: AuthContext, runId: string): Promise<Pick<AnalysisRunState, "status">>;
    evidence(context: AuthContext, runId: string): Promise<QueryEvidence[]>;
  };
  conversations: {
    get(
      context: AuthContext,
      id: string,
    ): Promise<{
      conversation: { id: string; title: string | null };
      messages: ConversationMessage[];
    } | null>;
  };
};
export type { ReportManagementRepository, ReportManagementDependencies };
