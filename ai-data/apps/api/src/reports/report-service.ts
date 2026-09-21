import { saveReportInputSchema, type SavedReport } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { ApiQueryAuthorization } from "../app-types";
import type { AnalysisRunService } from "../analysis-runs/analysis-run-service";
import { runTime } from "../analysis-runs/run-time";
import { assertEvidenceAccess } from "../evidence/evidence-access";
import { ApplicationError } from "../errors/application-error";
import type { ReportRepository, RunReportGuard, ReportManagementChecks } from "./report-types";

/** 报告保存来源快照，分享和历史版本读取时重新核对数据权限。 */
class ReportService {
  constructor(
    private readonly repository: ReportRepository,
    private readonly runs: Pick<AnalysisRunService, "evidence">,
    private readonly authorization: ApiQueryAuthorization,
    private readonly management?: ReportManagementChecks,
  ) {}

  async get(context: AuthContext, reportId: string, version?: number): Promise<SavedReport> {
    const latest = await this.repository.find(context.organizationId, reportId);
    const definition = await this.management?.findDefinitionHead(context, reportId);
    const acl = definition ?? latest;
    if (
      !latest ||
      !acl ||
      (acl.user_id !== context.userId && !acl.shared_with.includes(context.userId))
    )
      throw new ApplicationError("NOT_FOUND", "报告不存在");
    const report =
      version === undefined || version === latest.version
        ? latest
        : await this.repository.find(context.organizationId, reportId, version);
    if (!report || report.organization_id !== context.organizationId)
      throw new ApplicationError("NOT_FOUND", "报告不存在");
    await this.management?.source(context, report.analysis_run_id, false);
    await Promise.all(
      report.sources.map((source) => assertEvidenceAccess(source, context, this.authorization)),
    );
    return report;
  }

  async save(
    context: AuthContext,
    input: unknown,
    reportId?: string,
    expectedVersion?: number,
    guard?: RunReportGuard,
  ): Promise<SavedReport> {
    const request = saveReportInputSchema.parse(input);
    if (!guard) await this.management?.source(context, request.analysis_run_id, true);
    await this.management?.assertActiveUsers(context.organizationId, request.shared_with);
    const evidence = await this.runs.evidence(context, request.analysis_run_id);
    const references = new Set(
      request.sections.flatMap((section) => section.blocks.flatMap((block) => block.evidence_ids)),
    );
    const sources = evidence.filter((source) => references.has(source.evidence_id));
    if (sources.length !== references.size)
      throw new ApplicationError("INVALID_INPUT", "报告证据不属于当前运行");
    for (const section of request.sections)
      for (const block of section.blocks) {
        if (
          block.columns?.some(
            (field) =>
              !sources.some(
                (source) =>
                  block.evidence_ids.includes(source.evidence_id) &&
                  source.result.columns.some((column) => column.name === field),
              ),
          )
        )
          throw new ApplicationError("INVALID_INPUT", "展示列不属于来源结果");
        if (
          block.type === "chart" &&
          !sources.some(
            (source) =>
              block.evidence_ids.includes(source.evidence_id) &&
              source.result.columns.some((column) => column.name === block.chart!.x) &&
              source.result.columns.some(
                (column) =>
                  column.name === block.chart!.y &&
                  ["integer", "decimal"].includes(column.data_type),
              ),
          )
        )
          throw new ApplicationError("INVALID_INPUT", "图表坐标不符合来源列定义");
      }
    const snapshot = {
      ...request,
      sources,
      organization_id: context.organizationId,
      user_id: context.userId,
      created_at: runTime(),
    };
    return this.repository.transaction(async (executor) => {
      const report = await this.repository.save(
        context,
        snapshot,
        reportId,
        expectedVersion,
        guard,
        executor,
      );
      if (!guard) await this.management?.onSaved?.(context, report, executor);
      return report;
    });
  }

  /** 独立快照的分享变更生成新版本；有统一定义时由定义服务管理 ACL。 */
  async share(
    context: AuthContext,
    reportId: string,
    expectedVersion: number,
    sharedWith: string[],
  ): Promise<SavedReport> {
    const current = await this.get(context, reportId);
    if (current.user_id !== context.userId)
      throw new ApplicationError("NOT_FOUND", "报告不存在或不可修改");
    return this.save(
      context,
      {
        analysis_run_id: current.analysis_run_id,
        title: current.title,
        sections: current.sections,
        shared_with: sharedWith,
      },
      reportId,
      expectedVersion,
    );
  }
}
export { ReportService };
