import { z } from "zod";
import { queryOperatorSchema } from "./query-operators";
import { dataTypeSchema, isDataValue } from "../shared/data-values";

/**
 * 允许出现在 DSL 中的对象名、字段名和别名。
 * 这里不接受 SQL 表达式，只接受简单的标识符或带别名的字段引用。
 */
const identifier = z
  /** 所有对象名和字段名必须是字符串。 */
  .string()
  /** 仅允许安全标识符，不允许 SQL 片段、空格或特殊符号。 */
  .regex(/^[A-Za-z_][A-Za-z0-9_.]*$/);

/** 查询 DSL 支持的一条过滤条件。 */
const filterConditionSchema = z
  .object({
    /** 待过滤的字段或别名字段；由 identifier 规则校验。 */
    field: identifier,

    /** 只允许合同中声明的比较操作，避免任意表达式。 */
    op: queryOperatorSchema,

    /** API 按目录字段元数据确定的实际参数类型。 */
    data_type: dataTypeSchema,

    /** 过滤值是可选的；is_null 和 not_null 等操作不需要值。 */
    value: z.unknown().optional(),
  })
  /** 禁止过滤对象出现未定义字段。 */
  .strict()
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

/** 过滤条件组；组内可以继续嵌套 AND/OR 组。 */
type FilterCondition = z.infer<typeof filterConditionSchema>;
type FilterGroup = {
  logic: "and" | "or";
  items: Array<FilterCondition | FilterGroup>;
};

const filterGroupSchema: z.ZodType<FilterGroup> = z
  .object({
    /** 当前组内条件的逻辑关系。 */
    logic: z.enum(["and", "or"]),
    /** 条件或嵌套条件组。 */
    items: z.array(z.union([filterConditionSchema, z.lazy(() => filterGroupSchema)])).default([]),
  })
  .strict();

/** 查询 DSL 中的一条表连接定义。 */
const joinSchema = z
  .object({
    /** 当前支持内连接、左连接和右连接，禁止其他 Join 类型。 */
    type: z.enum(["inner", "left", "right"]),

    /** 被连接的数据对象 ID；必须符合安全标识符规则。 */
    object_id: identifier,

    /** 当前连接对象在查询中的别名；必须符合安全标识符规则。 */
    alias: identifier,

    /** 连接条件，只允许字段之间的等值连接。 */
    /** 连接条件必须是数组，每个元素代表一组字段比较。 */
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
          /** 禁止 Join 条件附带未定义字段。 */
          .strict(),
      )
      /** 至少需要一条连接条件，禁止笛卡尔积。 */
      .min(1),
  })
  /** 禁止连接对象出现未定义字段。 */
  .strict();

/** 查询结果中的字段或聚合字段。 */
const selectSchema = z
  .object({
    /** 原始字段或别名字段；必须符合安全标识符规则。 */
    field: identifier,

    /** 可选聚合函数，只允许已审核的聚合能力；不填写表示原始字段。 */
    aggregation: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]).optional(),

    /** 返回结果中的字段别名；没有别名时由编译器生成。 */
    as: identifier.optional(),
  })
  /** 禁止选择项附带未定义字段。 */
  .strict();

/** 关系查询的主对象引用。 */
const fromSchema = z
  .object({
    object_id: identifier,
    alias: identifier,
  })
  .strict();

/** 关系查询的排序项。 */
const orderBySchema = z
  .object({
    /** 要排序的字段或别名字段。 */
    field: identifier,
    /** 排序方向。 */
    direction: z.enum(["asc", "desc"]),
  })
  .strict();

/** 关系表查询 DSL；默认支持过滤、Join、聚合、分组和排序。 */
const relationalQuerySchema = z
  .object({
    /** 固定查询类型。 */
    type: z.literal("relational_query"),
    /** 已授权的数据源配置标识。 */
    source_id: z.string().min(1, "source_id 不能为空"),
    /** 查询的主数据对象。 */
    from: fromSchema,
    /** 参与查询的其他数据对象。 */
    joins: z.array(joinSchema).default([]),
    /** 要返回的字段或聚合字段。 */
    select: z.array(selectSchema).min(1, "select 至少需要一个字段"),
    /** 用户问题中的业务筛选条件；模型通过嵌套组决定 AND/OR。 */
    filters: filterGroupSchema.default({ logic: "and", items: [] }),
    /** 分组字段。 */
    group_by: z.array(identifier).default([]),
    /** 排序字段和方向。 */
    order_by: z.array(orderBySchema).default([]),
    /** 结果行数上限。 */
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

/** 存储过程或 HTTP API 的一条输入参数值。 */
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

/** 存储过程或 HTTP API 查询 DSL；输入条件与返回表字段分离。 */
const parameterizedQuerySchema = z
  .object({
    /** 固定查询类型。 */
    type: z.literal("parameterized_query"),
    /** 已授权的数据源配置标识。 */
    source_id: z.string().min(1, "source_id 不能为空"),
    /** 参数化数据集对象。 */
    from: fromSchema,
    /** API 允许本次调用使用的输入参数。 */
    parameters: z.array(queryParameterValueSchema).default([]),
    /** 存储过程或 HTTP API 返回固定结果结构，不由模型选择字段。 */
    /** 结果行数上限；是否需要及具体上限由 API/Data 按数据集语义决定。 */
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

/** API 传给 Data Access Service 的统一查询 DSL。 */
const queryDslSchema = z.discriminatedUnion("type", [
  relationalQuerySchema,
  parameterizedQuerySchema,
]);

export {
  filterConditionSchema,
  filterGroupSchema,
  orderBySchema,
  parameterizedQuerySchema,
  queryDslSchema,
  relationalQuerySchema,
};
