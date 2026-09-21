import type { z } from "zod";
import type {
  reportExecutionInputSchema,
  reportExecutionResultSchema,
  reportExecutionSchema,
  reportNarrativeSchema,
  reportExecutionExportContentSchema,
} from "./report-execution";
/** 固定版本与参数执行请求。 */
type ReportExecutionInput = z.infer<typeof reportExecutionInputSchema>;
/** 单个查询的结果证据。 */
type ReportExecutionResult = z.infer<typeof reportExecutionResultSchema>;
/** 可重复读取的报表执行记录。 */
type ReportExecution = z.infer<typeof reportExecutionSchema>;
/** 指定执行结果的分析说明。 */
type ReportNarrative = z.infer<typeof reportNarrativeSchema>;
/** 可供 Web 生成文件的指定执行内容包。 */
type ReportExecutionExportContent = z.infer<typeof reportExecutionExportContentSchema>;
export type {
  ReportExecutionInput,
  ReportExecutionResult,
  ReportExecution,
  ReportNarrative,
  ReportExecutionExportContent,
};
