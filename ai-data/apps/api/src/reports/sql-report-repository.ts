import { createHash, randomUUID } from "node:crypto";
import dayjs from "dayjs";
import {
  analysisRunSchema,
  savedReportSchema,
  stableStringify,
  type SavedReport,
} from "@ai-data/contracts";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { ReportRepository, ReportSnapshot, RunReportGuard } from "./report-types";
import { runTimeMilliseconds } from "../analysis-runs/run-time";

class SqlReportRepository implements ReportRepository {
  constructor(private readonly database: MetadataTransactionalExecutor) {}
  async find(
    organizationId: string,
    reportId: string,
    version?: number,
  ): Promise<SavedReport | null> {
    const result = await this.database.execute({
      sql: "SELECT TOP (1) report_json FROM dbo.saved_reports WHERE organization_id=@org AND report_id=@id AND (@version IS NULL OR version=@version) ORDER BY version DESC",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: reportId },
        { name: "version", type: "integer", value: version ?? null },
      ],
    });
    return result.rows[0]
      ? parseStoredRecord(() =>
          savedReportSchema.parse(JSON.parse(String(result.rows[0].report_json)) as unknown),
        )
      : null;
  }
  async save(
    context: AuthContext,
    snapshot: ReportSnapshot,
    reportId?: string,
    expectedVersion?: number,
    guard?: RunReportGuard,
  ): Promise<SavedReport> {
    return this.database.transaction(async (executor) => {
      if (guard) {
        const current = await executor.execute({
          sql: "SELECT s.state_json FROM dbo.analysis_run_states s WITH (UPDLOCK,HOLDLOCK) JOIN dbo.analysis_runs r ON r.id=s.analysis_run_id WHERE r.id=@run AND r.user_id=@user AND r.organization_id=@org",
          parameters: [
            { name: "run", type: "string", value: snapshot.analysis_run_id },
            { name: "user", type: "string", value: context.userId },
            { name: "org", type: "string", value: context.organizationId },
          ],
        });
        if (!current.rows[0]) throw new ApplicationError("NOT_FOUND", "分析运行不存在");
        const state = parseStoredRecord(() =>
          analysisRunSchema.parse(JSON.parse(String(current.rows[0].state_json)) as unknown),
        );
        if (
          state.status !== "running" ||
          state.lease?.owner !== guard.lease.owner ||
          state.lease_epoch !== guard.lease.epoch ||
          !dayjs(runTimeMilliseconds(state.lease.expires_at)).isAfter(dayjs())
        )
          throw new ApplicationError("CONFLICT", "报告保存时运行租约已失效");
      }
      const id =
        reportId ??
        (guard
          ? createHash("sha256")
              .update(snapshot.analysis_run_id + ":" + guard.key)
              .digest("hex")
          : randomUUID());
      const parameters = [
        { name: "org", type: "string" as const, value: context.organizationId },
        { name: "id", type: "string" as const, value: id },
      ];
      const result = await executor.execute({
        sql: "SELECT TOP (1) version,user_id,report_json FROM dbo.saved_reports WITH (UPDLOCK,HOLDLOCK) WHERE organization_id=@org AND report_id=@id ORDER BY version DESC",
        parameters,
      });
      const previous = result.rows[0];
      if (guard && previous) {
        const report = parseStoredRecord(() =>
          savedReportSchema.parse(JSON.parse(String(previous.report_json)) as unknown),
        );
        const comparable = (value: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(value).filter(
              ([key]) => !["report_id", "version", "created_at"].includes(key),
            ),
          );
        const prior = comparable(report);
        const next = comparable(snapshot);
        if (stableStringify(prior) !== stableStringify(next))
          throw new ApplicationError("CONFLICT", "报告操作键已用于其他内容");
        return report;
      }
      if (reportId && (!previous || previous.user_id !== context.userId))
        throw new ApplicationError("NOT_FOUND", "报告不存在或不可修改");
      if (previous && previous.version !== expectedVersion)
        throw new ApplicationError("CONFLICT", "报告已更新，请重新读取当前版本");
      const report = savedReportSchema.parse({
        ...snapshot,
        organization_id: context.organizationId,
        user_id: context.userId,
        report_id: id,
        version: Number(previous?.version ?? 0) + 1,
      });
      await executor.execute({
        sql: "INSERT INTO dbo.saved_reports (organization_id,report_id,version,user_id,report_json) VALUES (@org,@id,@version,@user,@json)",
        parameters: [
          ...parameters,
          { name: "version", type: "integer", value: report.version },
          { name: "user", type: "string", value: context.userId },
          { name: "json", type: "string", value: JSON.stringify(report) },
        ],
      });
      return report;
    });
  }
}
export { SqlReportRepository };
