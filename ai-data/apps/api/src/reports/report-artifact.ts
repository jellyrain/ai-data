import { createHash } from "node:crypto";
import type { SavedReport } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { reportArtifactRecordSchema } from "./report-artifact-record";

/** 与快照写入共享事务；运行完成状态由正式产物读取入口检查。 */
async function persistReportArtifact(
  executor: MetadataQueryExecutor,
  report: SavedReport,
): Promise<void> {
  const artifact = reportArtifactRecordSchema.parse({
    artifact_id: createHash("sha256").update(`${report.report_id}:${report.version}`).digest("hex"),
    report_id: report.report_id,
    report_version: report.version,
    analysis_run_id: report.analysis_run_id,
    title: report.title,
    sections: report.sections,
    created_at: report.created_at,
  });
  await executor.execute({
    sql: "INSERT INTO dbo.analysis_artifacts (organization_id,analysis_run_id,artifact_id,record_json) VALUES (@org,@run,@id,@json)",
    parameters: [
      { name: "org", type: "string", value: report.organization_id },
      { name: "run", type: "string", value: report.analysis_run_id },
      { name: "id", type: "string", value: artifact.artifact_id },
      { name: "json", type: "string", value: JSON.stringify(artifact) },
    ],
  });
}
export { persistReportArtifact };
