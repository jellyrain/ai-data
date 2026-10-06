import { z } from "zod";
import { savedReportSchema } from "./report";
import { reportDefinitionVersionSchema } from "./report-definition";
import { queryEvidenceSchema } from "../evidence/evidence";
import { dateTimeSchema } from "../shared/data-values";
import { analysisRunStatusSchema } from "../analysis-runs/analysis-run";

const id = z.string().min(1).max(128);
/** 当前 ACL 的修改同时受作者和预期版本约束。 */
const reportSharingInputSchema = z
  .object({ expected_version: z.number().int().positive(), shared_with: z.array(id).max(1000) })
  .strict();
/** 产物保存稳定展示快照，公开读取时还需检查来源运行完成及当前数据权限。 */
const analysisArtifactSchema = z.object({ artifact_id: id, report: savedReportSchema }).strict();
/** 仅在完整授权通过后返回列表摘要，避免泄露标题和来源。 */
const reportSummarySchema = z
  .object({
    report_id: id,
    title: z.string().min(1).max(512),
    description: z.string().max(1000).optional(),
    display_type: z.enum(["table", "line", "bar", "pie", "legacy"]).optional(),
    updated_at: dateTimeSchema.optional(),
    user_id: id,
    definition_version: z.number().int().positive().optional(),
    snapshot_version: z.number().int().positive().optional(),
    created_at: dateTimeSchema,
    shared_with: z.array(id).max(1000),
  })
  .strict();
/** 稳定标识游标适用于连续翻页，省略数量时默认返回 20 条。 */
const reportListInputSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: id.optional() })
  .strict();
const reportListSchema = z
  .object({ items: z.array(reportSummarySchema).max(100), next_cursor: id.optional() })
  .strict();
/** 内容包说明保存结果是否完整；截断内容不能表示完整明细。 */
const exportEvidenceSchema = z
  .object({ evidence: queryEvidenceSchema, availability: z.enum(["complete", "truncated"]) })
  .strict()
  .refine(
    (value) => value.availability === (value.evidence.result.truncated ? "truncated" : "complete"),
    "导出完整性必须与保存结果一致",
  );
/** 报表内容包完全来自固定快照，读取时不会重跑查询。 */
const reportExportContentSchema = z
  .object({
    kind: z.literal("report"),
    report: savedReportSchema,
    tables: z.array(exportEvidenceSchema).max(1000),
  })
  .strict();
/** 会话消息保留用户可见顺序和运行状态，来源表格仅引用成功完成运行。 */
const conversationExportContentSchema = z
  .object({
    kind: z.literal("conversation"),
    conversation_id: id,
    title: z.string().nullable(),
    messages: z.array(
      z
        .object({
          message_id: id,
          role: z.enum(["user", "assistant"]),
          sequence: z.number().int().nonnegative(),
          content: z.string(),
          analysis_run_id: id.optional(),
          created_at: dateTimeSchema,
        })
        .strict(),
    ),
    runs: z.array(z.object({ analysis_run_id: id, status: analysisRunStatusSchema }).strict()),
    artifacts: z.array(analysisArtifactSchema),
    tables: z.array(exportEvidenceSchema),
  })
  .strict();
/** 版本集合显式区分定义和快照的版本序列。 */
const reportVersionListSchema = z
  .object({
    definitions: z.array(reportDefinitionVersionSchema),
    snapshots: z.array(savedReportSchema),
  })
  .strict();
export {
  reportSharingInputSchema,
  analysisArtifactSchema,
  reportSummarySchema,
  reportListInputSchema,
  reportListSchema,
  exportEvidenceSchema,
  reportExportContentSchema,
  conversationExportContentSchema,
  reportVersionListSchema,
};
