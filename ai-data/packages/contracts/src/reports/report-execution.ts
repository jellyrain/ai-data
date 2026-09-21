import { z } from "zod";
import { dateTimeSchema } from "../shared/data-values";
import { queryEvidenceSchema } from "../evidence/evidence";
import { reportDefinitionSchema, reportParameterValueSchema } from "./report-definition";
import { savedReportSchema } from "./report";
const id = z.string().min(1).max(128);
/** 按固定定义版本执行，操作键仅在当前用户和报表范围内复用。 */
const reportExecutionInputSchema = z
  .object({
    definition_version: z.number().int().positive(),
    idempotency_key: id,
    parameters: z.record(z.string().min(1).max(128), reportParameterValueSchema).default({}),
  })
  .strict();
/** 查询结果引用完整证据，单查询产生单张输出表。 */
const reportExecutionResultSchema = z
  .object({ query_id: id, evidence: queryEvidenceSchema })
  .strict();
/** 执行记录固定定义与实际参数，失败执行只保留审计，不交付部分结果。 */
const reportExecutionSchema = z
  .object({
    execution_id: id,
    report_id: id,
    organization_id: id,
    user_id: id,
    definition_version: z.number().int().positive(),
    definition: reportDefinitionSchema,
    parameters: z.record(z.string(), reportParameterValueSchema),
    status: z.enum(["running", "completed", "failed"]),
    analysis_run_id: id,
    lease_epoch: z.number().int().positive(),
    deadline: dateTimeSchema,
    created_at: dateTimeSchema,
    completed_at: dateTimeSchema.optional(),
    results: z.array(reportExecutionResultSchema).max(100).default([]),
    snapshot: savedReportSchema.optional(),
    error_code: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.status === "completed" &&
      (record.results.length !== record.definition.queries.length || !record.snapshot)
    )
      context.addIssue({ code: "custom", message: "完成执行必须提供全部查询结果及快照" });
    if (record.status !== "completed" && (record.results.length || record.snapshot))
      context.addIssue({ code: "custom", message: "未完成执行不能交付结果快照" });
    if (record.status === "completed") {
      const queryIds = record.results.map((result) => result.query_id);
      if (
        new Set(queryIds).size !== queryIds.length ||
        record.definition.queries.some((query) => !queryIds.includes(query.query_id))
      )
        context.addIssue({ code: "custom", message: "执行结果必须与每个查询项一一对应" });
      if (
        record.results.some(
          (result) =>
            result.evidence.analysis_run_id !== record.analysis_run_id ||
            result.evidence.organization_id !== record.organization_id ||
            result.evidence.user_id !== record.user_id,
        )
      )
        context.addIssue({ code: "custom", message: "执行证据归属不一致" });
      if (
        record.snapshot?.report_id !== record.report_id ||
        record.snapshot.execution_id !== record.execution_id ||
        record.snapshot.definition_version !== record.definition_version
      )
        context.addIssue({ code: "custom", message: "执行快照的报表、执行及定义版本必须匹配" });
    }
  });
/** 说明单独绑定已经完成的执行，不会随下次参数运行自动更新。 */
const reportNarrativeSchema = z
  .object({
    execution_id: id,
    analysis_run_id: id,
    content: z.string().min(1).max(64000),
    query_ids: z.array(id).min(1).max(100),
    created_at: dateTimeSchema,
  })
  .strict();
/** 执行导出固定结果，同时携带仅属于该执行的分析说明。 */
const reportExecutionExportContentSchema = z
  .object({
    kind: z.literal("report_execution"),
    execution: reportExecutionSchema,
    narratives: z.array(reportNarrativeSchema),
  })
  .strict();
export {
  reportExecutionInputSchema,
  reportExecutionResultSchema,
  reportExecutionSchema,
  reportNarrativeSchema,
  reportExecutionExportContentSchema,
};
