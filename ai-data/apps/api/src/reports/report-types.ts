import type { SavedReport, RunLease } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";

type ReportSnapshot = Omit<SavedReport, "report_id" | "version">;
/** 分析工具保存报告时携带当前租约与稳定操作键。 */
type RunReportGuard = { lease: RunLease; key: string };
/** 仓储在事务中检查作者和预期版本，防止覆盖并发修改。 */
interface ReportRepository {
  find(organizationId: string, reportId: string, version?: number): Promise<SavedReport | null>;
  save(
    context: AuthContext,
    snapshot: ReportSnapshot,
    reportId?: string,
    expectedVersion?: number,
    guard?: RunReportGuard,
  ): Promise<SavedReport>;
}
export type { ReportSnapshot, ReportRepository, RunReportGuard };
