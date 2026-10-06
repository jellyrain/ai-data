import type { ReportExecution } from "@ai-data/contracts";
/** 未覆盖、明确空值和输入值分别提交，默认条件由 API 解析。 */
type ParameterDraft = { mode: "default" | "null" | "value"; raw: string };
/** 每个参数单独保留是否覆盖及原始输入。 */
type ParameterDrafts = Record<string, ParameterDraft>;
/** 与公共执行接口保持相同的参数值类型。 */
type ParameterValues = ReportExecution["parameters"];
export type { ParameterDraft, ParameterDrafts, ParameterValues };
