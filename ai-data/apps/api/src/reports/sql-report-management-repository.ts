import { z } from "zod";
import { analysisArtifactSchema, type AnalysisArtifact } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { ReportManagementRepository } from "./report-management-types";
import { reportArtifactRecordSchema } from "./report-artifact-record";

/** 管理查询只读取 API 元数据，报表内容的授权交给服务层统一处理。 */
class SqlReportManagementRepository implements ReportManagementRepository {
  constructor(private readonly database: MetadataQueryExecutor) {}
  async listReportIds(
    organizationId: string,
    after: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const result = await this.database.execute({
      sql: "SELECT TOP (@limit) report_id FROM (SELECT report_id FROM dbo.saved_reports WHERE organization_id=@org UNION SELECT report_id FROM dbo.report_templates WHERE organization_id=@org) reports WHERE (@after IS NULL OR report_id>@after) ORDER BY report_id",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "after", type: "string", value: after ?? null },
        { name: "limit", type: "integer", value: limit },
      ],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() => z.string().min(1).max(128).parse(row.report_id)),
    );
  }
  async snapshotVersions(organizationId: string, reportId: string): Promise<number[]> {
    const result = await this.database.execute({
      sql: "SELECT version FROM dbo.saved_reports WHERE organization_id=@org AND report_id=@id ORDER BY version DESC",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "id", type: "string", value: reportId },
      ],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() => z.number().int().positive().parse(row.version)),
    );
  }
  async artifacts(organizationId: string, runId: string): Promise<AnalysisArtifact[]> {
    const result = await this.database.execute({
      sql: "SELECT a.record_json,r.report_json FROM dbo.analysis_artifacts a JOIN dbo.saved_reports r ON r.organization_id=a.organization_id AND r.report_id=JSON_VALUE(a.record_json,'$.report_id') AND r.version=TRY_CONVERT(INT,JSON_VALUE(a.record_json,'$.report_version')) WHERE a.organization_id=@org AND a.analysis_run_id=@run ORDER BY a.artifact_id",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "run", type: "string", value: runId },
      ],
    });
    return result.rows.map((row) =>
      parseStoredRecord(() =>
        analysisArtifactSchema.parse({
          artifact_id: reportArtifactRecordSchema.parse(
            JSON.parse(String(row.record_json)) as unknown,
          ).artifact_id,
          report: JSON.parse(String(row.report_json)) as unknown,
        }),
      ),
    );
  }
}
export { SqlReportManagementRepository };
