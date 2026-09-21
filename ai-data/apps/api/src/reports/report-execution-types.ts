import type {
  ReportDefinitionVersion,
  ReportExecution,
  QueryEvidence,
  ReportNarrative,
} from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import type { ReportQueryService } from "./report-query-service";

/** 执行与操作键在一个事务内建立，完成记录与运行终态共享事务。 */
interface ReportExecutionRepository {
  findOperation(
    context: AuthContext,
    reportId: string,
    key: string,
  ): Promise<{ record: ReportExecution; requestHash: string } | null>;
  start(
    context: AuthContext,
    reportId: string,
    requestHash: string,
    key: string,
    definition: ReportDefinitionVersion,
    parameters: ReportExecution["parameters"],
    deadline: string,
  ): Promise<{ record: ReportExecution; isNew: boolean }>;
  find(
    context: AuthContext,
    executionId: string,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportExecution | null>;
  finish(
    context: AuthContext,
    record: ReportExecution,
    executor?: MetadataQueryExecutor,
  ): Promise<ReportExecution>;
}
/** 执行完全依赖固定定义与授权查询服务，未包含模型调用。 */
type ReportExecutionDependencies = {
  repository: ReportExecutionRepository;
  definitions: {
    get(
      context: AuthContext,
      reportId: string,
      version?: number,
      executor?: MetadataQueryExecutor,
    ): Promise<ReportDefinitionVersion>;
  };
  builder: Pick<ReportQueryService, "build">;
  runs: Pick<AnalysisRunService, "claim" | "query" | "complete" | "fail" | "interrupt" | "renew">;
  refreshContext(context: AuthContext): Promise<AuthContext>;
  authorizeEvidence(
    context: AuthContext,
    evidence: QueryEvidence,
    executor?: MetadataQueryExecutor,
  ): Promise<void>;
  timeoutMilliseconds?: number;
  now?: () => number;
  narratives?(context: AuthContext, executionId: string): Promise<ReportNarrative[]>;
};
export type { ReportExecutionRepository, ReportExecutionDependencies };
