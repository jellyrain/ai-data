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

/** 发现工具默认返回 20 条摘要；游标只允许有界偏移，关键词按空白拆分。 */
const discoveryFields = {
  query: z.string().trim().min(1).max(500).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .refine((value) => Number(value) <= 1000000)
    .optional(),
  limit: z.number().int().min(1).max(30).default(20),
};

/** 模型工具参数只表达业务目标，身份、运行和租约由执行器绑定。 */
const toolInputs = {
  get_tool_schema: z.object({ tool_name: z.string().min(1).max(128) }).strict(),
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
      ...discoveryFields,
      scope: memoryScopeSchema.optional(),
    })
    .strict()
    .refine((value) => !value.version || Boolean(value.knowledge_id), "指定版本需要知识标识")
    .refine(
      (value) => !value.knowledge_id || (!value.query && !value.cursor && !value.scope),
      "知识详情不能同时指定索引筛选",
    ),
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
  list_metrics: z
    .object({ ...discoveryFields, source_id: z.string().min(1).max(128).optional() })
    .strict(),
  describe_metric: z
    .object({ metric_id: z.string().min(1), version: z.number().int().positive().optional() })
    .strict(),
  query_metric: z
    .object({
      metric_id: z.string().min(1),
      version: metricExecutionInputSchema.shape.version,
      start: metricExecutionInputSchema.shape.start.describe(
        "范围起点，包含该值。匹配 describe_metric 返回的 date_basis.data_type：date 使用 YYYY-MM-DD；datetime 使用 YYYY-MM-DD HH:mm:ss（空格分隔，UTC+8）。按当前用户要求填写。",
      ),
      end: metricExecutionInputSchema.shape.end.describe(
        "范围终点，包含该值且不能早于 start。匹配 describe_metric 返回的 date_basis.data_type：date 使用 YYYY-MM-DD；datetime 使用 YYYY-MM-DD HH:mm:ss（空格分隔，UTC+8）。与 start 使用相同格式，按当前用户要求填写。",
      ),
      dimensions: metricExecutionInputSchema.shape.dimensions.describe(
        "从 describe_metric 返回的 dimensions 中选择完整字段名（含别名），每项只传一次；[] 表示全量汇总。",
      ),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.start.length !== value.end.length)
        context.addIssue({
          code: "custom",
          path: ["end"],
          message: "start 和 end 必须使用相同的日期格式，并匹配指标时间类型",
        });
      else if (value.end < value.start)
        context.addIssue({
          code: "custom",
          path: ["end"],
          message: "end 不能早于 start，请按用户要求核对时间范围",
        });
    }),
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
  get_tool_schema:
    "按需读取当前 Agent 已启用工具的完整参数定义。大型工具调用前先读取定义，再将业务参数对象序列化为 arguments_json 提交给原名工具；压缩后可重新读取。",
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
  get_published_knowledge:
    "发现已生效企业知识的分页索引；选定 knowledge_id 和 version 后读取正文。支持关键词与适用范围筛选，索引不含完整定义。",
  create_knowledge_candidate:
    "提交待审核的业务规则或指标候选；本轮成功完成后后台整理，负责人审核发布后才能成为正式口径。",
  read_skill_reference:
    "按需读取当前已加载 Skill 中的 Markdown 子文档。根据 SKILL.md 的指引选择文档，relative_path 相对于该 Skill 目录，例如 references/relational-query.md。",
  list_sources: "发现当前有权查询的健康数据源标识。",
  search_catalog:
    "按业务关键词搜索授权数据集摘要；多个关键词用空格分隔。选定对象后通过 describe_dataset 读取字段与参数。",
  list_datasets: "分页读取授权数据集摘要；字段、参数和关联通过 describe_dataset 按需读取。",
  describe_dataset: "读取数据集字段、查询能力和批准的业务关联。",
  query_dataset: "执行受控 DSL 查询，返回有界结果及证据标识。",
  list_metrics: "搜索或分页浏览授权指标摘要和固定时间依据；选定后用 describe_metric 读取完整口径。",
  describe_metric:
    "读取指定指标版本的定义、时间依据、统计规则及 query_requirements 调用要求（时间格式、合法维度和格式示例）。",
  query_metric:
    "按指标固定口径查询分组和完整总计，并保存证据。先读取 describe_metric 的 query_requirements，按实际时间类型填写 start/end；维度使用已发布字段名。",
  request_clarification: "保存一个需要用户回答的业务问题并暂停本次运行。",
  save_report: "将当前运行的证据与结论保存为个人报告快照。",
};
/** 大型参数通过有界 JSON 字符串承载，解码后继续使用原严格业务合同。 */
const toolArgumentsSchema = z.object({ arguments_json: z.string().min(2).max(65536) }).strict();
const schemaOnDemandTools = new Set([
  "query_dataset",
  "save_report_definition",
  "save_user_preference",
  "create_knowledge_candidate",
]);
export { toolInputs, toolDescriptions, toolArgumentsSchema, schemaOnDemandTools };
