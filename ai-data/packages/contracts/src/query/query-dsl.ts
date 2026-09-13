import { z } from "zod";
import { datasetColumnSchema } from "../catalog/dataset";
import { queryOperatorSchema } from "./query-operators";
import { dataTypeSchema, isDataValue } from "../shared/data-values";
import { preAggregateSchema } from "./pre-aggregate";
import type { PreAggregate } from "./pre-aggregate-types";

/**
 * DSL 中的对象名、字段名和别名，允许使用点号限定引用。
 * 这一层检查字符形式；对象和字段是否可用，由后续目录与授权校验确定。
 */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/);

/** 查询 DSL 的单条过滤条件，仅接受合同定义的字段。 */
const filterConditionSchema = z
  .object({
    /** 待过滤的字段或别名字段；由 identifier 规则校验。 */
    field: identifier,

    /** 只允许合同中声明的比较操作，避免任意表达式。 */
    op: queryOperatorSchema,

    /** API 按目录字段元数据确定的实际参数类型。 */
    data_type: dataTypeSchema,

    /**
     * 过滤值的形态由 op 和 data_type 共同决定，在下方 superRefine 中联合校验。
     * is_null、not_null 必须省略此字段；其他操作必须提供值。
     */
    value: z.unknown().optional(),
  })
  .strict()
  /**
   * 按操作符检查取值形态：
   * - is_null、not_null：省略 value。
   * - in、not_in：非空数组。
   * - between：恰好两个值。
   * - 其他操作：单个值。
   * 所有提供的值还须符合 data_type。
   */
  .superRefine((condition, context) => {
    const noValue = condition.op === "is_null" || condition.op === "not_null";
    const arrayValue = condition.op === "in" || condition.op === "not_in";
    const betweenValue = condition.op === "between";

    if (noValue && condition.value !== undefined) {
      context.addIssue({ code: "custom", message: "is_null 和 not_null 不能配置 value" });
      return;
    }
    if (!noValue && condition.value === undefined) {
      context.addIssue({ code: "custom", message: "该操作必须配置 value" });
      return;
    }
    if (arrayValue && (!Array.isArray(condition.value) || condition.value.length === 0)) {
      context.addIssue({ code: "custom", message: "in 和 not_in 必须配置非空数组 value" });
    }
    if (betweenValue && (!Array.isArray(condition.value) || condition.value.length !== 2)) {
      context.addIssue({ code: "custom", message: "between 必须配置包含两个值的数组 value" });
    }
    if (!noValue && !arrayValue && !betweenValue && Array.isArray(condition.value)) {
      context.addIssue({ code: "custom", message: "该操作必须配置单个 value" });
    }
    if (condition.value !== undefined) {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      if (!values.every((value) => isDataValue(value, condition.data_type))) {
        context.addIssue({ code: "custom", message: "value 必须符合 data_type" });
      }
    }
  });

/** 通过操作符和取值校验后的单条过滤条件。 */
type FilterCondition = z.infer<typeof filterConditionSchema>;
/** 递归过滤组的类型边界，用于为自引用 Schema 提供显式类型。 */
type FilterGroup = {
  /** 当前组内各项的连接关系。 */
  logic: "and" | "or";
  /** 单条条件或下一层过滤组。 */
  items: Array<FilterCondition | FilterGroup>;
};

/**
 * 允许嵌套 AND/OR 的过滤组，仅接受声明字段。
 * z.lazy 延迟读取组 Schema，避免声明时立即求值自引用。
 */
const filterGroupSchema: z.ZodType<FilterGroup> = z
  .object({
    /** 当前组内条件的逻辑关系。 */
    logic: z.enum(["and", "or"]),
    /** 条件或嵌套组；省略时为空组；编译器对根组和嵌套组分别处理。 */
    items: z.array(z.union([filterConditionSchema, z.lazy(() => filterGroupSchema)])).default([]),
  })
  .strict();

/** 关系查询中的对象连接，仅接受声明字段；on 内的字段对同样拒绝未知字段。 */
const joinSchema = z
  .object({
    /** 当前支持内连接、左连接和右连接，禁止其他 Join 类型。 */
    type: z.enum(["inner", "left", "right"]),

    /** 被连接的目录对象引用，实际可用性由目录和授权流程确认。 */
    object_id: identifier,

    /** 当前连接对象的查询内别名，用于限定字段归属。 */
    alias: identifier,

    /** API 目录中已批准关系的标识；省略时由 API 按字段等值条件匹配关系。 */
    relation_id: identifier.min(1, "relation_id 不能为空").optional(),

    /** 此对象参与关联前执行的过滤；只引用自身别名，省略时使用完整对象输入。 */
    filters: filterGroupSchema.optional(),

    /** 当前对象完成原始字段过滤后执行的分组投影；省略时以原始粒度参与关联。 */
    pre_aggregate: preAggregateSchema.optional(),

    /** 至少一组字段等值条件，多个条件以 AND 连接；目录校验进一步确认字段和对象归属。 */
    on: z
      .array(
        z
          .object({
            /** 左侧表字段。 */
            left: identifier,
            /** 当前仅允许等值 Join。 */
            op: z.literal("eq"),
            /** 右侧表字段。 */
            right: identifier,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine(validatePreAggregateAlias);

/** 查询结果中的字段或聚合项，仅接受声明字段。 */
const selectSchema = z
  .object({
    /** 目录字段引用，可带查询内对象别名。 */
    field: identifier,

    /** 可选聚合函数，只允许已审核的聚合能力；不填写表示原始字段。 */
    aggregation: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]).optional(),

    /** 返回结果中的字段别名；没有别名时由编译器生成。 */
    as: identifier.optional(),
  })
  .strict();

/** 两类查询共用的主对象引用，仅接受声明字段。 */
const fromSchema = z
  .object({
    /** 本次查询的数据源内对象引用。 */
    object_id: identifier,
    /** 查询内引用该对象使用的别名。 */
    alias: identifier,
  })
  .strict();

/** 表和视图可在进入关联前过滤自身记录，参数化对象沿用参数绑定合同。 */
const relationalFromSchema = fromSchema
  .extend({
    /** 主对象参与关联前的过滤，仅允许引用主对象别名。 */
    filters: filterGroupSchema.optional(),
    /** 主对象完成原始字段过滤后执行的分组投影；省略时保持原始粒度。 */
    pre_aggregate: preAggregateSchema.optional(),
  })
  .superRefine(validatePreAggregateAlias);

/** 关系查询的排序项，仅接受声明字段。 */
const orderBySchema = z
  .object({
    /** 要排序的字段或别名字段。 */
    field: identifier,
    /** 排序方向。 */
    direction: z.enum(["asc", "desc"]),
  })
  .strict();

/** 关系查询 DSL，仅接受声明字段；声明过滤、关联、聚合等结构，实际能力由目录与连接器约束。 */
const relationalQuerySchema = z
  .object({
    /** 固定查询类型。 */
    type: z.literal("relational_query"),
    /** 已授权的数据源配置标识。 */
    source_id: z.string().min(1, "source_id 不能为空"),
    /** 查询的主数据对象。 */
    from: relationalFromSchema,
    /** 参与关联的其他对象；省略时仅查询主对象。 */
    joins: z.array(joinSchema).default([]),
    /** 要返回的字段或聚合字段。 */
    select: z.array(selectSchema).min(1, "select 至少需要一个字段"),
    /** 查询级筛选条件，通过嵌套组表达 AND/OR；省略时为空组。 */
    filters: filterGroupSchema.default({ logic: "and", items: [] }),
    /** 聚合使用的分组字段；省略时不添加分组。 */
    group_by: z.array(identifier).default([]),
    /** 排序字段和方向；省略时不指定结果顺序。 */
    order_by: z.array(orderBySchema).default([]),
    /** 显式结果行数上限，合同最多接受 5000；省略时交由执行侧的数据源上限控制。 */
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

/** 存储过程或 HTTP API 的参数绑定值，仅接受声明字段；取值须匹配 data_type。 */
const queryParameterValueSchema = z
  .object({
    /** 必须匹配 dataset.query_parameters 和 API 白名单。 */
    name: identifier,
    /** API 计算或模型确定的参数值；具体类型由目录参数定义校验。 */
    value: z.unknown(),
    /** API 根据数据集参数定义写入的实际绑定类型。 */
    data_type: dataTypeSchema,
  })
  .strict()
  .superRefine((parameter, context) => {
    if (!isDataValue(parameter.value, parameter.data_type)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "value 必须符合 data_type" });
    }
  });

/** 参数化查询 DSL，仅接受声明字段；以命名参数调用存储过程或 HTTP API，返回列由数据集定义。 */
const parameterizedQuerySchema = z
  .object({
    /** 固定查询类型。 */
    type: z.literal("parameterized_query"),
    /** 已授权的数据源配置标识。 */
    source_id: z.string().min(1, "source_id 不能为空"),
    /** 参数化数据集对象。 */
    from: fromSchema,
    /** 本次调用的参数绑定值；省略时按空列表处理，必填约束由目录参数校验确定。 */
    parameters: z.array(queryParameterValueSchema).default([]),
    /**
     * API 依据已审核的可信完整目录重建的输出声明，随请求签名；DAS 与本地定义比较。
     * 调用方可省略，API 授权后必须提供；重复列不能代表完整输出。
     */
    expected_output: z
      .array(datasetColumnSchema)
      .min(1)
      .superRefine((columns, context) => {
        if (new Set(columns.map((column) => column.name)).size !== columns.length)
          context.addIssue({ code: "custom", message: "固定输出列名不能重复" });
      })
      .optional(),
    /** 显式结果行数上限，合同最多接受 5000；省略时交由执行侧的数据源上限控制。 */
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

/** 依据 type 选择关系查询或参数化查询结构，分别校验各自允许的字段。 */
const queryDslSchema = z.discriminatedUnion("type", [
  relationalQuerySchema,
  parameterizedQuerySchema,
]);

/** 预聚合只读取所属对象的原始字段，跨对象数据在外层连接后引用。 */
function validatePreAggregateAlias(
  object: { alias: string; pre_aggregate?: PreAggregate },
  context: z.RefinementCtx,
): void {
  const aggregate = object.pre_aggregate;
  if (!aggregate) return;
  for (const [index, field] of aggregate.group_by.entries()) {
    if (field.split(".")[0] !== object.alias) {
      context.addIssue({
        code: "custom",
        path: ["pre_aggregate", "group_by", index],
        message: "预聚合分组字段只能引用自身对象别名",
      });
    }
  }
  for (const [index, item] of aggregate.select.entries()) {
    if (item.field.split(".")[0] !== object.alias) {
      context.addIssue({
        code: "custom",
        path: ["pre_aggregate", "select", index, "field"],
        message: "预聚合输出字段只能引用自身对象别名",
      });
    }
  }
}

export {
  filterConditionSchema,
  filterGroupSchema,
  orderBySchema,
  parameterizedQuerySchema,
  queryDslSchema,
  relationalQuerySchema,
};
