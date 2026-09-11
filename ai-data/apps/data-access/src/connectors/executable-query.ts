import { dataTypeSchema, isDataValue, queryOperatorSchema } from "@ai-data/contracts";
import { z } from "zod";

/** 连接器可安全使用的对象、字段和别名标识符。 */
const identifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

/** 连接器可直接编译为参数绑定条件的一条最终过滤条件。 */
const executableFilterConditionSchema = z
  .object({
    /** 已解析为当前对象别名字段的过滤字段。 */
    field: identifierSchema,
    /** 查询规划器已校验允许使用的受控比较操作。 */
    op: queryOperatorSchema,
    /** API 已按目录字段元数据确认的真实参数类型。 */
    data_type: dataTypeSchema,
    /** 操作符对应的已类型校验值；空值判断操作不携带值。 */
    value: z.unknown().optional(),
  })
  /** 连接器不得接收原始表达式、SQL 片段或其他未定义字段。 */
  .strict()
  .superRefine((condition, context) => {
    const needsNoValue = condition.op === "is_null" || condition.op === "not_null";
    const needsArrayValue = condition.op === "in" || condition.op === "not_in";
    const needsRangeValue = condition.op === "between";

    if (needsNoValue && condition.value !== undefined) {
      context.addIssue({ code: "custom", message: "空值判断不能携带 value" });
    }
    if (!needsNoValue && condition.value === undefined) {
      context.addIssue({ code: "custom", message: "比较条件必须携带 value" });
    }
    if (needsArrayValue && (!Array.isArray(condition.value) || condition.value.length === 0)) {
      context.addIssue({ code: "custom", message: "in 和 not_in 必须使用非空数组" });
    }
    if (needsRangeValue && (!Array.isArray(condition.value) || condition.value.length !== 2)) {
      context.addIssue({ code: "custom", message: "between 必须使用两个值" });
    }
    if (!needsNoValue && !needsArrayValue && !needsRangeValue && Array.isArray(condition.value)) {
      context.addIssue({ code: "custom", message: "该操作只能使用单个 value" });
    }
    if (condition.value !== undefined) {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      if (!values.every((value) => isDataValue(value, condition.data_type))) {
        context.addIssue({ code: "custom", message: "value 必须符合 data_type" });
      }
    }
  });

/** 查询规划器已经处理完成的一条最终过滤条件类型。 */
type ExecutableFilter = z.infer<typeof executableFilterConditionSchema>;

/** 最终过滤条件树；API 已将授权条件与用户条件合并到根查询树中。 */
type ExecutableFilterGroup = {
  logic: "and" | "or";
  items: Array<ExecutableFilter | ExecutableFilterGroup>;
};

const executableFilterGroupSchema: z.ZodType<ExecutableFilterGroup> = z
  .object({
    /** 当前条件组的连接逻辑。 */
    logic: z.enum(["and", "or"]),
    /** 当前组的过滤条件或嵌套过滤组。 */
    items: z.array(
      z.union([executableFilterConditionSchema, z.lazy(() => executableFilterGroupSchema)]),
    ),
  })
  /** 最终过滤树不能携带任意 SQL 或权限上下文字段。 */
  .strict();

/** 连接器只接受已由查询规划器映射完成的物理数据对象。 */
const executableRelationSchema = z
  .object({
    /** DAS 本地暴露白名单中的逻辑对象标识，用于审计与结果证据。 */
    object_id: identifierSchema,
    /** 业务数据库中的真实 Schema；HTTP API 虚拟表不需要该字段。 */
    native_schema_name: identifierSchema.optional(),
    /** 已审核的物理表、视图、存储过程或 HTTP API 虚拟表名称。 */
    native_object_name: identifierSchema,
    /** 查询规划器已验证的关系别名。 */
    alias: identifierSchema,
  })
  /** 防止将上游请求体、连接信息或未经处理权限字段带入连接器。 */
  .strict();

/** 已物理映射的数据对象类型。 */
type ExecutableRelation = z.infer<typeof executableRelationSchema>;

/** 已经映射为物理对象的 Join 定义。 */
const executableJoinSchema = z
  .object({
    /** 当前只支持可安全编译的标准 Join 类型。 */
    type: z.enum(["inner", "left", "right"]),
    /** 参与 Join 的已映射关系。 */
    relation: executableRelationSchema,
    /** 已验证的字段等值连接条件，多个条件使用 AND 连接。 */
    on: z
      .array(
        z
          .object({
            /** Join 左侧已经解析完成的别名字段。 */
            left: identifierSchema,
            /** 第一版 Join 仅允许等值条件。 */
            op: z.literal("eq"),
            /** Join 右侧已经解析完成的别名字段。 */
            right: identifierSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** API 已验证业务规则后的最终选择列。 */
const executableSelectSchema = z
  .object({
    /** 已解析的别名字段引用。 */
    field: identifierSchema,
    /** 已允许的聚合函数；省略表示返回原始字段。 */
    aggregation: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]).optional(),
    /** 已验证的返回列名称。 */
    as: identifierSchema,
  })
  .strict();

/** 最终排序项。 */
const executableOrderBySchema = z
  .object({
    /** 已验证可排序的字段或返回列别名。 */
    field: identifierSchema,
    /** 排序只允许两个固定方向。 */
    direction: z.enum(["asc", "desc"]),
  })
  .strict();

/** 可直接编译为数据库方言 SQL 的最终关系查询。 */
const executableRelationalQuerySchema = z
  .object({
    /** 判别关系查询分支，连接器据此选择 SQL 编译路径。 */
    type: z.literal("relational_query"),
    /** 数据源管理器用此标识选择运行时连接器实例。 */
    source_id: z.string().min(1),
    /** 已被数据源限制收紧的连接器执行超时。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 已被数据源限制收紧的最大返回行数。 */
    row_limit: z.number().int().min(1).max(5000),
    /** 主对象物理映射。 */
    from: executableRelationSchema,
    /** Join 对象物理映射。 */
    joins: z.array(executableJoinSchema),
    /** API 已合并授权条件后的最终过滤条件。 */
    filters: executableFilterGroupSchema,
    /** API 已验证业务规则的结果列。 */
    select: z.array(executableSelectSchema).min(1),
    /** 已验证的分组字段。 */
    group_by: z.array(identifierSchema),
    /** 已验证的排序字段。 */
    order_by: z.array(executableOrderBySchema),
  })
  .strict();

/** 连接器执行前的最终关系查询类型。 */
type ExecutableRelationalQuery = z.infer<typeof executableRelationalQuerySchema>;

/** 已解析并可映射到固定存储过程或 HTTP API 参数位置的一条最终参数。 */
const executableParameterSchema = z
  .object({
    /** 已审核的参数名称。 */
    name: identifierSchema,
    /** API 已完成业务校验的参数值。 */
    value: z.unknown(),
    /** API 已按数据集参数定义确认的实际绑定类型。 */
    data_type: dataTypeSchema,
  })
  .strict()
  .superRefine((parameter, context) => {
    if (!isDataValue(parameter.value, parameter.data_type)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "value 必须符合 data_type" });
    }
  });

/** 可直接调用固定存储过程或 HTTP API 虚拟表的最终参数化查询。 */
const executableParameterizedQuerySchema = z
  .object({
    /** 判别固定存储过程或 HTTP API 的参数化执行分支。 */
    type: z.literal("parameterized_query"),
    /** 数据源管理器据此选择运行时连接器。 */
    source_id: z.string().min(1),
    /** 查询规划器收紧后的执行超时，单位毫秒。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 查询规划器收紧后的最大返回行数。 */
    row_limit: z.number().int().min(1).max(5000),
    /** 已映射到固定存储过程或 API 虚拟表的对象。 */
    from: executableRelationSchema,
    /** API 已完成业务校验的调用参数。 */
    parameters: z.array(executableParameterSchema),
  })
  .strict();

/** 连接器执行前的最终参数化查询类型。 */
type ExecutableParameterizedQuery = z.infer<typeof executableParameterizedQuerySchema>;

/** 查询规划器交给数据源连接器的最终内部 DSL。 */
const executableQuerySchema = z.discriminatedUnion("type", [
  executableRelationalQuerySchema,
  executableParameterizedQuerySchema,
]);

/** 连接器唯一允许接收的最终查询类型。 */
type ExecutableQuery = z.infer<typeof executableQuerySchema>;

export {
  executableFilterConditionSchema,
  executableFilterGroupSchema,
  executableParameterizedQuerySchema,
  executableQuerySchema,
  executableRelationalQuerySchema,
  executableRelationSchema,
};

export type {
  ExecutableFilter,
  ExecutableFilterGroup,
  ExecutableParameterizedQuery,
  ExecutableQuery,
  ExecutableRelation,
  ExecutableRelationalQuery,
};
