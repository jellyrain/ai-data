import type {
  SavedReport,
  RunLease,
  QueryEvidence,
  ReportDefinitionVersion,
} from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { MetadataQueryExecutor } from "@ai-data/metadata";

/** 快照创建由仓储补充稳定报表标识和版本号。 */
type ReportSnapshot = Omit<SavedReport, "report_id" | "version">;
/** 分析工具保存报告时携带当前租约与稳定操作键。 */
type RunReportGuard = { lease: RunLease; key: string };
/** 完成状态、活跃分享账号及统一定义 ACL 的读取能力。 */
type ReportManagementChecks = {
  source(context: AuthContext, runId: string, requireOwner: boolean): Promise<QueryEvidence[]>;
  assertActiveUsers(organizationId: string, users: string[]): Promise<void>;
  findDefinitionHead(
    context: AuthContext,
    reportId: string,
  ): Promise<ReportDefinitionVersion | null>;
  /** 完成来源的人工保存同时生成可编辑定义，失败须整体回滚。 */
  onSaved?(
    context: AuthContext,
    report: SavedReport,
    executor: MetadataQueryExecutor,
  ): Promise<void>;
};
/** 仓储在事务中检查作者和预期版本，防止覆盖并发修改。 */
interface ReportRepository {
  transaction<T>(
    operation: (executor: MetadataQueryExecutor) => Promise<T>,
    executor?: MetadataQueryExecutor,
  ): Promise<T>;
  find(organizationId: string, reportId: string, version?: number): Promise<SavedReport | null>;
  save(
    context: AuthContext,
    snapshot: ReportSnapshot,
    reportId?: string,
    expectedVersion?: number,
    guard?: RunReportGuard,
    executor?: MetadataQueryExecutor,
  ): Promise<SavedReport>;
}
export type { ReportSnapshot, ReportRepository, RunReportGuard, ReportManagementChecks };
