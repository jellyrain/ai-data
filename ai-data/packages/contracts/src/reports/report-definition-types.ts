import type { z } from "zod";
import type {
  reportParameterSchema,
  reportParameterBindingSchema,
  reportQueryItemSchema,
  reportDefinitionSchema,
  saveReportDefinitionInputSchema,
  reportDefinitionVersionSchema,
  reusableReportBlockSchema,
  reportRevisionInputSchema,
} from "./report-definition";
/** 可编辑的报表参数。 */
type ReportParameter = z.infer<typeof reportParameterSchema>;
/** 参数在查询中的受控绑定位置。 */
type ReportParameterBinding = z.infer<typeof reportParameterBindingSchema>;
/** 单个输出表的逻辑查询。 */
type ReportQueryItem = z.infer<typeof reportQueryItemSchema>;
/** 对话、表单和画布共用的业务定义。 */
type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
/** 创建统一报表或可复用块的输入。 */
type SaveReportDefinitionInput = z.infer<typeof saveReportDefinitionInputSchema>;
/** 固定版本的报表定义。 */
type ReportDefinitionVersion = z.infer<typeof reportDefinitionVersionSchema>;
/** 包含完整查询依赖的可复用块。 */
type ReusableReportBlock = z.infer<typeof reusableReportBlockSchema>;
/** 自然语言修改的目标版本与输入。 */
type ReportRevisionInput = z.infer<typeof reportRevisionInputSchema>;
export type {
  ReportParameter,
  ReportParameterBinding,
  ReportQueryItem,
  ReportDefinition,
  SaveReportDefinitionInput,
  ReportDefinitionVersion,
  ReusableReportBlock,
  ReportRevisionInput,
};
