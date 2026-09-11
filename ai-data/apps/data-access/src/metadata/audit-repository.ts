import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { queryAuditEntrySchema, type QueryAuditEntry } from "./metadata-records";

/** 将每次执行、拒绝、超时或失败记录到 DAS 自己的元数据库审计表。 */
class AuditRepository {
  constructor(private readonly executor: MetadataQueryExecutor) {}

  /** 参数化写入审计事件，并返回 SQL Server 为该事件分配的递增审计 ID。 */
  async write(entry: QueryAuditEntry): Promise<number> {
    const audit = queryAuditEntrySchema.parse(entry);
    const result = await this.executor.execute({
      sql: `
        INSERT INTO dbo.query_audit_logs (
          correlation_id,
          analysis_run_id,
          user_id,
          organization_id,
          policy_version,
          source_id,
          object_ids_json,
          query_summary_json,
          parameters_summary_json,
          row_filter_injected,
          outcome,
          row_count,
          duration_ms,
          rejection_reason,
          error_code
        )
        OUTPUT INSERTED.audit_id AS audit_id
        VALUES (
          @correlation_id,
          @analysis_run_id,
          @user_id,
          @organization_id,
          @policy_version,
          @source_id,
          @object_ids_json,
          @query_summary_json,
          @parameters_summary_json,
          @row_filter_injected,
          @outcome,
          @row_count,
          @duration_ms,
          @rejection_reason,
          @error_code
        );
      `,
      parameters: [
        { name: "correlation_id", type: "string", value: audit.correlationId },
        { name: "analysis_run_id", type: "string", value: audit.analysisRunId ?? null },
        { name: "user_id", type: "string", value: audit.userId ?? null },
        { name: "organization_id", type: "string", value: audit.organizationId ?? null },
        { name: "policy_version", type: "integer", value: audit.policyVersion ?? null },
        { name: "source_id", type: "string", value: audit.sourceId ?? null },
        { name: "object_ids_json", type: "string", value: JSON.stringify(audit.objectIds) },
        {
          name: "query_summary_json",
          type: "string",
          value: JSON.stringify(audit.querySummary),
        },
        {
          name: "parameters_summary_json",
          type: "string",
          value: JSON.stringify(audit.parametersSummary),
        },
        { name: "row_filter_injected", type: "boolean", value: audit.rowFilterInjected },
        { name: "outcome", type: "string", value: audit.outcome },
        { name: "row_count", type: "bigint", value: audit.rowCount ?? null },
        { name: "duration_ms", type: "integer", value: audit.durationMs ?? null },
        { name: "rejection_reason", type: "string", value: audit.rejectionReason ?? null },
        { name: "error_code", type: "string", value: audit.errorCode ?? null },
      ],
    });
    const rawAuditId = result.rows[0]?.audit_id;
    const auditId =
      typeof rawAuditId === "number"
        ? rawAuditId
        : typeof rawAuditId === "string" && /^\d+$/.test(rawAuditId)
          ? Number(rawAuditId)
          : Number.NaN;

    if (typeof auditId !== "number" || !Number.isSafeInteger(auditId) || auditId < 1) {
      throw new Error("query_audit_logs 未返回有效 audit_id");
    }

    return auditId;
  }
}

export { AuditRepository };
