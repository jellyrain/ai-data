import { z } from "zod";
import { dateSchema, dateTimeSchema } from "../shared/data-values";
import { relationalQuerySchema } from "../query/query-dsl";

const id = z.string().min(1).max(128);
const field = z
  .string()
  .regex(
    /^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*\.[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*$/u,
  );
/** 指标值由受控聚合列或分子分母形成，零分母返回 null。 */
const metricValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("column"), column: id }).strict(),
  z.object({ type: z.literal("ratio"), numerator: id, denominator: id }).strict(),
]);
/** 发布后的版本不可改写，日期依据在同一指标的所有版本中固定。 */
const metricDefinitionSchema = z
  .object({
    metric_id: id,
    version: z.number().int().positive(),
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(8000),
    aliases: z.array(z.string().min(1).max(256)).max(100),
    grain: z.string().min(1).max(1000),
    deduplication_keys: z.array(field).max(100),
    date_basis: z.object({ field, data_type: z.enum(["date", "datetime"]) }).strict(),
    query: relationalQuerySchema,
    dimensions: z.array(field).max(50),
    value: metricValueSchema,
    /** 总计在完整授权范围重查，跨组去重与比率均依照同一统计定义计算。 */
    total_rule: z.literal("recalculate"),
  })
  .strict()
  .superRefine((metric, context) => {
    const aliases = new Set([
      metric.query.from.alias,
      ...metric.query.joins.map((join) => join.alias),
    ]);
    const outputs = new Set(metric.query.select.map((item) => item.as));
    const refs =
      metric.value.type === "column"
        ? [metric.value.column]
        : [metric.value.numerator, metric.value.denominator];
    if (
      refs.some((ref) => !outputs.has(ref)) ||
      metric.query.select.some((item) => !item.as || !item.aggregation) ||
      metric.query.group_by.length
    )
      context.addIssue({
        code: "custom",
        message: "指标基础查询须输出具名聚合列，分组由执行维度确定",
      });
    for (const ref of [metric.date_basis.field, ...metric.dimensions, ...metric.deduplication_keys])
      if (!aliases.has(ref.split(".")[0]))
        context.addIssue({ code: "custom", message: "指标字段须属于查询对象" });
    if (new Set(metric.dimensions).size !== metric.dimensions.length)
      context.addIssue({ code: "custom", message: "指标维度不能重复" });
  });
/** 执行时仅提供固定时间范围和已发布维度，范围包含起始和结束值。 */
const metricExecutionInputSchema = z
  .object({
    analysis_run_id: id,
    version: z.number().int().positive().optional(),
    idempotency_key: id,
    start: z.union([dateSchema, dateTimeSchema]),
    end: z.union([dateSchema, dateTimeSchema]),
    dimensions: z.array(field).max(50).default([]),
  })
  .strict()
  .refine(
    (value) => value.start.length === value.end.length && value.start <= value.end,
    "时间范围起点不能晚于终点",
  );

export { metricDefinitionSchema, metricExecutionInputSchema, metricValueSchema };
