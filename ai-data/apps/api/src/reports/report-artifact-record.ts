import { z } from "zod";
import { saveReportInputSchema, savedReportSchema } from "@ai-data/contracts";

/** 运行产物固定展示描述和证据标识，查询结果由报告版本与证据表提供。 */
const reportArtifactRecordSchema = saveReportInputSchema.omit({ shared_with: true }).extend({
  artifact_id: z.string().min(1).max(128),
  report_id: z.string().min(1).max(128),
  report_version: z.number().int().positive(),
  created_at: savedReportSchema.shape.created_at,
});
export { reportArtifactRecordSchema };
