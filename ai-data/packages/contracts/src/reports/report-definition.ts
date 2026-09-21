import { z } from "zod";
import { dataTypeSchema, dateSchema, dateTimeSchema, isDataValue } from "../shared/data-values";
import {
  filterGroupSchema,
  parameterizedQuerySchema,
  relationalQuerySchema,
} from "../query/query-dsl";
import { queryOperatorSchema } from "../query/query-operators";
import { preAggregateSchema } from "../query/pre-aggregate";
import { preferenceTimeRangeSchema } from "../memory/user-preference";

const id = z.string().min(1).max(128);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/);
const scalar = z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null()]);
/** 参数值只接受可序列化标量或有界数组；实际类型及上下限按定义再次校验。 */
const reportParameterValueSchema = z.union([scalar, z.array(scalar).min(1).max(1000)]);
/** 所有编辑入口使用同一参数定义，默认值与相对日期默认值互斥。 */
const reportParameterSchema = z
  .object({
    name: identifier.max(128),
    label: z.string().min(1).max(256),
    data_type: dataTypeSchema,
    /** 默认必填；可选且无默认值时跳过其绑定条件。 */
    required: z.boolean().default(true),
    default_value: reportParameterValueSchema.optional(),
    allowed_values: z.array(scalar).min(1).max(1000).optional(),
    min: z.union([z.number().finite(), z.string()]).optional(),
    max: z.union([z.number().finite(), z.string()]).optional(),
    /** 仅日期参数可以在每次运行时解析范围或某一端点。 */
    relative_time: z
      .object({ range: preferenceTimeRangeSchema, part: z.enum(["start", "end", "range"]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((parameter, context) => {
    const values = [
      ...(parameter.allowed_values ?? []),
      ...(parameter.default_value === undefined
        ? []
        : Array.isArray(parameter.default_value)
          ? parameter.default_value
          : [parameter.default_value]),
    ];
    if (values.some((value) => !isDataValue(value, parameter.data_type)))
      context.addIssue({ code: "custom", message: "参数默认值及允许值须符合声明类型" });
    if (
      parameter.relative_time &&
      (parameter.default_value !== undefined || !["date", "datetime"].includes(parameter.data_type))
    )
      context.addIssue({
        code: "custom",
        message: "相对日期默认值仅适用于日期类型且不能同时提供固定默认值",
      });
    if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max)
      context.addIssue({ code: "custom", message: "参数下限不能大于上限" });
    if (
      [parameter.min, parameter.max].some(
        (value) =>
          value !== undefined &&
          (!isDataValue(value, parameter.data_type) ||
            ["boolean", "buffer"].includes(parameter.data_type)),
      )
    )
      context.addIssue({ code: "custom", message: "参数边界必须符合可比较的数据类型" });
  });
/** 绑定目标明确区分查询条件、对象预过滤、连接条件、命名输入和指标日期。 */
const reportParameterBindingSchema = z
  .object({
    parameter: identifier.max(128),
    target: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("filter"),
          field: identifier,
          op: queryOperatorSchema.exclude(["is_null", "not_null"]),
          scope: z.enum(["query", "from", "join", "on"]).default("query"),
          alias: identifier.optional(),
        })
        .strict(),
      z.object({ type: z.literal("parameter"), name: identifier }).strict(),
      z.object({ type: z.literal("metric_date"), part: z.enum(["start", "end"]) }).strict(),
    ]),
  })
  .strict();
/** 查询图的边引用批准关系；完整字段对由服务从当前目录生成。 */
const reportJoinSchema = z
  .object({
    type: z.enum(["inner", "left", "right"]),
    object_id: identifier,
    alias: identifier,
    source_alias: identifier,
    relation_id: identifier,
    filters: filterGroupSchema.optional(),
    on_filters: filterGroupSchema.optional(),
    pre_aggregate: preAggregateSchema.optional(),
  })
  .strict();
/** 关系图保留现有 DSL 的投影及聚合能力，连接使用稳定业务关系。 */
const reportRelationalQuerySchema = relationalQuerySchema.extend({
  joins: z.array(reportJoinSchema).max(50).default([]),
});
/** 指标查询将分组与总计作为显式查询项，同一次执行固定实际指标版本。 */
const reportMetricQuerySchema = z
  .object({
    type: z.literal("metric_query"),
    metric_id: id,
    version: z.number().int().positive().optional(),
    output: z.enum(["grouped", "total"]),
    start: z.union([dateSchema, dateTimeSchema]),
    end: z.union([dateSchema, dateTimeSchema]),
    dimensions: z.array(identifier).max(50).default([]),
  })
  .strict();
/** 一个查询项只产生一张表，展示重复引用不会新增查询。 */
const reportQueryItemSchema = z
  .object({
    query_id: identifier.max(128),
    query: z.discriminatedUnion("type", [
      reportRelationalQuerySchema,
      parameterizedQuerySchema,
      reportMetricQuerySchema,
    ]),
    bindings: z.array(reportParameterBindingSchema).max(100).default([]),
  })
  .strict();
/** 静态说明绑定原执行，运行时生成的说明单独保存到指定执行。 */
const reportPresentationBlockSchema = z
  .object({
    block_id: id,
    type: z.enum(["text", "table", "chart"]),
    title: z.string().min(1).max(512),
    query_ids: z.array(identifier.max(128)).min(1).max(100),
    columns: z.array(identifier).min(1).max(200).optional(),
    chart: z
      .object({ type: z.enum(["line", "bar", "pie"]), x: identifier, y: identifier })
      .strict()
      .optional(),
    content: z.string().max(64000).optional(),
    source_execution_id: id.optional(),
  })
  .strict()
  .superRefine((block, context) => {
    if (block.type === "chart" && !block.chart)
      context.addIssue({ code: "custom", message: "图表必须声明坐标字段" });
    if (block.type !== "text" && block.query_ids.length !== 1)
      context.addIssue({ code: "custom", message: "表格与图表必须引用一个查询项" });
    if (block.type === "text" && !block.content)
      context.addIssue({ code: "custom", message: "说明块必须提供内容" });
  });
/** 统一定义独立于编辑入口；所有引用均在保存前完整校验，未知字段拒绝。 */
const reportDefinitionSchema = z
  .object({
    title: z.string().min(1).max(512),
    parameters: z.array(reportParameterSchema).max(100).default([]),
    queries: z.array(reportQueryItemSchema).min(1).max(100),
    presentation: z
      .array(
        z
          .object({
            section_id: id,
            title: z.string().min(1).max(512),
            blocks: z.array(reportPresentationBlockSchema).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    /** 引用固定块版本；查询和参数依赖完整展开在当前定义并由保存服务核对映射。 */
    block_references: z
      .array(
        z
          .object({
            block_id: id,
            version: z.number().int().positive(),
            query_id_map: z.record(identifier, identifier),
            parameter_map: z.record(identifier, identifier),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    /** 布局只描述显示位置，不参与生成查询。 */
    editor_layout: z
      .object({
        nodes: z
          .array(z.object({ id, x: z.number().finite(), y: z.number().finite() }).strict())
          .max(1000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const parameters = new Set(definition.parameters.map((p) => p.name));
    const queries = new Set(definition.queries.map((q) => q.query_id));
    const blocks = definition.presentation.flatMap((s) => s.blocks);
    for (const [path, values] of [
      ["parameters", definition.parameters.map((p) => p.name)],
      ["queries", definition.queries.map((q) => q.query_id)],
      ["presentation", definition.presentation.map((s) => s.section_id)],
      ["blocks", blocks.map((b) => b.block_id)],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", path: [path], message: "标识不能重复" });
    }
    for (const item of definition.queries)
      for (const binding of item.bindings)
        if (!parameters.has(binding.parameter))
          context.addIssue({ code: "custom", message: `绑定参数不存在：${binding.parameter}` });
    for (const item of definition.queries) {
      const targets = item.bindings.map((binding) => JSON.stringify(binding.target));
      if (new Set(targets).size !== targets.length)
        context.addIssue({ code: "custom", message: "同一筛选或输入位置不能重复绑定参数" });
    }
    for (const block of blocks)
      if (block.query_ids.some((query) => !queries.has(query)))
        context.addIssue({ code: "custom", message: "展示引用的查询项不存在" });
    for (const ref of definition.block_references) {
      if (
        Object.values(ref.query_id_map).some((q) => !queries.has(q)) ||
        Object.values(ref.parameter_map).some((p) => !parameters.has(p))
      )
        context.addIssue({ code: "custom", message: "块的查询与参数映射不完整" });
    }
    if (JSON.stringify(definition).length > 512000)
      context.addIssue({ code: "custom", message: "报表定义超过容量限制" });
  });
/** 全部入口均提交完整定义；来源只记录归属，不能授予执行权限。 */
const saveReportDefinitionInputSchema = z
  .object({
    definition: reportDefinitionSchema,
    source_analysis_run_id: id.optional(),
    source_artifact_id: id.optional(),
    shared_with: z.array(id).max(1000).default([]),
  })
  .strict();
/** 模板是统一定义的持久化版本，report_id 在跨入口编辑时保持稳定。 */
const reportDefinitionVersionSchema = saveReportDefinitionInputSchema.extend({
  report_id: id,
  version: z.number().int().positive(),
  organization_id: id,
  user_id: id,
  created_at: dateTimeSchema,
});
/** 可复用块包含完整查询与展示依赖，采用相同版本和权限规则。 */
const reusableReportBlockSchema = saveReportDefinitionInputSchema.extend({
  block_id: id,
  version: z.number().int().positive(),
  organization_id: id,
  user_id: id,
  created_at: dateTimeSchema,
});
/** 对话修改绑定基准版本，操作键防止重复创建分析运行。 */
const reportRevisionInputSchema = z
  .object({
    expected_version: z.number().int().positive(),
    prompt: z.string().min(1).max(32000),
    idempotency_key: id,
    agent_id: id.optional(),
  })
  .strict();

export {
  reportParameterValueSchema,
  reportParameterSchema,
  reportParameterBindingSchema,
  reportRelationalQuerySchema,
  reportMetricQuerySchema,
  reportQueryItemSchema,
  reportPresentationBlockSchema,
  reportDefinitionSchema,
  saveReportDefinitionInputSchema,
  reportDefinitionVersionSchema,
  reusableReportBlockSchema,
  reportRevisionInputSchema,
};
