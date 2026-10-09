import { z } from "zod";

/** 对象内预聚合的输入字段必须以一个对象别名限定，字段存在性与授权由 API 和 DAS 检查。 */
const inputField = z
  .string()
  .regex(
    /^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*\.[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*$/u,
    "字段必须是 alias.field 引用",
  );

/** 对象内预聚合的输出列，仅接受声明字段；每项必须声明可供外层引用的单段列名。 */
const preAggregateSelectSchema = z
  .object({
    /** 当前对象的原始字段引用；对象 Schema 进一步检查别名归属。 */
    field: inputField,
    /** 已审核的聚合函数；省略时直接输出分组字段。 */
    aggregation: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]).optional(),
    /** 外层通过对象别名和此列名引用结果；同一对象的输出名必须唯一。 */
    as: z
      .string()
      .min(1, "as 不能为空")
      .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*$/u, "as 必须是单段安全标识符"),
  })
  .strict();

/**
 * 在原始对象过滤后、对象关联前执行的分组投影，仅接受声明字段。
 * group_by 定义输出粒度；仅输出分组字段时实现复合键去重，最终行数上限由外层查询控制。
 */
const preAggregateSchema = z
  .object({
    /** 当前对象参与分组的原始字段；至少一个字段，并且都必须作为普通列投影。 */
    group_by: z.array(inputField).min(1, "group_by 至少需要一个字段"),
    /** 分组字段和聚合值的完整输出；至少一个字段。 */
    select: z.array(preAggregateSelectSchema).min(1, "select 至少需要一个字段"),
  })
  .strict()
  /** 分组键全部可供外层关联；普通投影必须由分组粒度确定，输出名称在对象内保持唯一。 */
  .superRefine((aggregate, context) => {
    const groups = new Set(aggregate.group_by);
    const projectedGroups = new Set(
      aggregate.select.filter((item) => !item.aggregation).map((item) => item.field),
    );
    for (const [index, field] of aggregate.group_by.entries()) {
      if (!projectedGroups.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["group_by", index],
          message: "分组字段必须作为非聚合输出列",
        });
      }
    }
    const outputNames = new Set<string>();
    for (const [index, item] of aggregate.select.entries()) {
      if (!item.aggregation && !groups.has(item.field)) {
        context.addIssue({
          code: "custom",
          path: ["select", index, "field"],
          message: "非聚合输出字段必须属于 group_by",
        });
      }
      if (outputNames.has(item.as)) {
        context.addIssue({
          code: "custom",
          path: ["select", index, "as"],
          message: "预聚合输出列名不能重复",
        });
      }
      outputNames.add(item.as);
    }
  });

export { preAggregateSchema, preAggregateSelectSchema };
