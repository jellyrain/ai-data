import { z } from "zod";
import {
  clarificationSchema,
  describeDatasetInputSchema,
  listDatasetsInputSchema,
  metricExecutionInputSchema,
  queryDatasetInputSchema,
  reportSectionSchema,
  searchCatalogInputSchema,
} from "@ai-data/contracts";

/** 模型工具参数只表达业务目标，身份、运行和租约由执行器绑定。 */
const toolInputs = {
  read_skill_reference: z
    .object({
      /** 本次运行已加载的 Skill 名称。 */
      skill_name: z.string().min(1).max(64),
      /** Skill 目录内的 Markdown 路径，使用正斜线，例如 references/relational-query.md。 */
      relative_path: z.string().min(1).max(512),
    })
    .strict(),
  list_sources: z.object({}).strict(),
  search_catalog: searchCatalogInputSchema,
  list_datasets: listDatasetsInputSchema,
  describe_dataset: describeDatasetInputSchema,
  query_dataset: queryDatasetInputSchema,
  list_metrics: z.object({}).strict(),
  describe_metric: z
    .object({ metric_id: z.string().min(1), version: z.number().int().positive().optional() })
    .strict(),
  query_metric: z
    .object({
      metric_id: z.string().min(1),
      version: metricExecutionInputSchema.shape.version,
      start: metricExecutionInputSchema.shape.start,
      end: metricExecutionInputSchema.shape.end,
      dimensions: metricExecutionInputSchema.shape.dimensions,
    })
    .strict(),
  request_clarification: z
    .object({
      question: clarificationSchema.shape.question,
      options: clarificationSchema.shape.options,
      allow_custom_input: clarificationSchema.shape.allow_custom_input,
    })
    .strict(),
  save_report: z
    .object({
      title: z.string().min(1).max(512),
      sections: z.array(reportSectionSchema).min(1).max(100),
    })
    .strict(),
};

/** 输入与结果摘要按工具用途生成，审计记录不保存原始结果行。 */
const toolDescriptions: Record<keyof typeof toolInputs, string> = {
  read_skill_reference:
    "按需读取当前已加载 Skill 中的 Markdown 子文档。根据 SKILL.md 的指引选择文档，relative_path 相对于该 Skill 目录，例如 references/relational-query.md。",
  list_sources: "发现当前有权查询的健康数据源标识。",
  search_catalog: "按业务关键词搜索当前有权使用的数据集。",
  list_datasets: "分页读取一个数据源中当前有权使用的数据集。",
  describe_dataset: "读取数据集字段、查询能力和批准的业务关联。",
  query_dataset: "执行受控 DSL 查询，返回有界结果及证据标识。",
  list_metrics: "列出当前有权使用的指标和固定时间口径。",
  describe_metric: "读取指定指标版本的定义、时间依据和统计规则。",
  query_metric: "按指标固定口径查询分组和完整总计，并保存证据。",
  request_clarification: "保存一个需要用户回答的业务问题并暂停本次运行。",
  save_report: "将当前运行的证据与结论保存为个人报告快照。",
};
export { toolInputs, toolDescriptions };
