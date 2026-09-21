import type { z } from "zod";
import type {
  analysisArtifactSchema,
  reportSummarySchema,
  reportListInputSchema,
  reportListSchema,
  reportExportContentSchema,
  conversationExportContentSchema,
  reportVersionListSchema,
} from "./report-management";
/** 已保存的分析展示产物。 */
type AnalysisArtifact = z.infer<typeof analysisArtifactSchema>;
/** 已经过全部读取授权的报表摘要。 */
type ReportSummary = z.infer<typeof reportSummarySchema>;
/** 报表列表分页参数。 */
type ReportListInput = z.infer<typeof reportListInputSchema>;
/** 报表列表和下一页游标。 */
type ReportList = z.infer<typeof reportListSchema>;
/** 供浏览器渲染及生成文件的报表内容包。 */
type ReportExportContent = z.infer<typeof reportExportContentSchema>;
/** 保留消息顺序和完整性信息的会话内容包。 */
type ConversationExportContent = z.infer<typeof conversationExportContentSchema>;
/** 定义版本与快照版本的独立历史。 */
type ReportVersionList = z.infer<typeof reportVersionListSchema>;
export type {
  AnalysisArtifact,
  ReportSummary,
  ReportListInput,
  ReportList,
  ReportExportContent,
  ConversationExportContent,
  ReportVersionList,
};
