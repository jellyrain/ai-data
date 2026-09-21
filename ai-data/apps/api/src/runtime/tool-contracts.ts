import { z } from "zod";
import {
  clarificationSchema,
  describeDatasetInputSchema,
  listDatasetsInputSchema,
  metricExecutionInputSchema,
  queryDatasetInputSchema,
  reportSectionSchema,
  searchCatalogInputSchema,
  userPreferenceInputSchema,
  knowledgeContentSchema,
  memoryScopeSchema,
  reportDefinitionSchema,
} from "@ai-data/contracts";

/** 模型工具参数只表达业务目标，身份、运行和租约由执行器绑定。 */
const toolInputs = {
  get_report_definition: z.object({ report_id: z.string().min(1).max(128).optional() }).strict(),
  save_report_definition: z.object({ definition: reportDefinitionSchema }).strict(),
  get_report_execution: z.object({ execution_id: z.string().min(1).max(128) }).strict(),
  get_user_preferences: z.object({}).strict(),
  save_user_preference: userPreferenceInputSchema.safeExtend({
    expected_version: z.number().int().nonnegative().optional(),
    confirmation_id: z.string().min(1).max(128).optional(),
  }),
  get_published_knowledge: z
    .object({
      knowledge_id: z.string().min(1).max(128).optional(),
      version: z.number().int().positive().optional(),
    })
    .strict()
    .refine((value) => !value.version || Boolean(value.knowledge_id), "指定版本需要知识标识"),
  create_knowledge_candidate: z
    .object({
      knowledge_id: z.string().min(1).max(128).optional(),
      /** 既有工具保留指标和业务规则合同；模板候选通过对应管理接口提交。 */
      content: z.discriminatedUnion("type", [
        knowledgeContentSchema.options[0],
        knowledgeContentSchema.options[1],
      ]),
      scope: memoryScopeSchema,
    })
    .strict(),
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
  get_report_definition:
    "读取当前绑定报表的统一定义、参数、查询项及基准版本；普通会话可以按 report_id 读取有权访问的定义。",
  save_report_definition:
    "暂存统一报表定义；成功回答后原子保存版本。当前编辑目标由 API 固定，新增报表也在成功后才保存。保存本身不查询数据。",
  get_report_execution:
    "读取有权访问的已完成报表执行及结果样本，分析说明必须说明结果截断或采样边界。",
  get_user_preferences:
    "读取当前账号可使用的偏好、停用设置、待确认事项及相对时间解析。当前问题和会话明确条件优先于默认值。",
  save_user_preference:
    "保存账号偏好，一般首次保存立即生效。使用已有 key 更新同一设置；冲突或恢复停用设置时由 API 处理确认。临时查询条件不能覆盖默认，相对日期保存 relative 语义。",
  get_published_knowledge: "读取当前有权使用、已生效的企业正式知识及版本，作为业务规则数据使用。",
  create_knowledge_candidate:
    "提交待审核的业务规则或指标候选；本轮成功完成后后台整理，负责人审核发布后才能成为正式口径。",
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
