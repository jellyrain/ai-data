import { MAX_QUERY_ROWS } from "@ai-data/contracts";
import {
  datasetColumnSchema,
  dataTypeSchema,
  isDataValue,
  preAggregateSchema,
  queryOperatorSchema,
} from "@ai-data/contracts";
import { z } from "zod";
import {
  postgresqlParameterTypeSchema,
  procedureOutputParameterSchema,
} from "../catalog/procedure-definition";

/** 内部 DSL 标识符的字符白名单；物理名称与关系别名由规划层提供。 */
const identifierSchema = z
  .string()
  .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_.$]*$/u, "必须是安全标识符");
/** 关系与输出别名只能占一个名称段，字段限定符由查询层级单独检查。 */
const aliasSchema = z
  .string()
  .regex(/^[\p{Script=Han}A-Za-z_][\p{Script=Han}A-Za-z0-9_$]*$/u, "必须是安全单段别名");

/** 最终参数绑定条件，仅接受声明字段；在内部执行边界再次检查操作符与值的组合。 */
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
  .strict()
  /**
   * 空值判断省略 value；in/not_in 使用非空数组，between 使用两个端点，其他比较使用单值。
   * 每个提供的值再按 data_type 检查，供编译器直接生成对应占位符。
   */
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

/** 规划器保留的查询级过滤树，用显式类型描述递归结构。 */
type ExecutableFilterGroup = {
  /** 本组条件的逻辑连接关系。 */
  logic: "and" | "or";
  /** 已校验条件或下一层过滤组。 */
  items: Array<ExecutableFilter | ExecutableFilterGroup>;
};

/** 递归过滤组，仅接受声明字段；z.lazy 延迟解析对自身的引用。 */
const executableFilterGroupSchema: z.ZodType<ExecutableFilterGroup> = z
  .object({
    /** 当前条件组的连接逻辑。 */
    logic: z.enum(["and", "or"]),
    /** 当前组的过滤条件或嵌套过滤组。 */
    items: z.array(
      z.union([executableFilterConditionSchema, z.lazy(() => executableFilterGroupSchema)]),
    ),
  })
  .strict();

/** 规划器映射后的物理对象引用，仅接受声明字段。 */
const executableRelationSchema = z
  .object({
    /** DAS 本地暴露白名单中的逻辑对象标识，用于审计与结果证据。 */
    object_id: identifierSchema,
    /** 业务数据库中的真实 Schema；HTTP API 虚拟表不需要该字段。 */
    native_schema_name: identifierSchema.optional(),
    /** 已审核的物理表、视图、存储过程或 HTTP API 虚拟表名称。 */
    native_object_name: identifierSchema,
    /** 查询规划器已验证的关系别名。 */
    alias: aliasSchema,
  })
  .strict();

/** 已物理映射的数据对象类型。 */
type ExecutableRelation = z.infer<typeof executableRelationSchema>;

/** 表和视图依次执行原始对象过滤、分组聚合，再作为关系参与关联。 */
const executableFilteredRelationSchema = executableRelationSchema.extend({
  /** API 已确定的对象范围，条件仅引用该对象别名。 */
  filters: executableFilterGroupSchema.optional(),
  /** 当前对象独立形成的分组输出；省略时保留原始字段，内部沿用公共严格聚合合同。 */
  pre_aggregate: preAggregateSchema.optional(),
});

/** 关系查询的对象物理映射与输入过滤。 */
type ExecutableFilteredRelation = z.infer<typeof executableFilteredRelationSchema>;

/** 已映射物理对象的 Join 定义；连接对象与 on 字段对均拒绝未知字段。 */
const executableJoinSchema = z
  .object({
    /** 批准列对之外的带值 ON 条件，仅使用当前连接作用域。 */
    on_filters: executableFilterGroupSchema.optional(),
    /** 当前只支持可安全编译的标准 Join 类型。 */
    type: z.enum(["inner", "left", "right"]),
    /** 参与 Join 的已映射关系。 */
    relation: executableFilteredRelationSchema,
    /** 至少一个字段等值条件，多个条件使用 AND 连接。 */
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

/** 规划后的结果选择列，仅接受声明字段。 */
const executableSelectSchema = z
  .object({
    /** 已解析的别名字段引用。 */
    field: identifierSchema,
    /** 已允许的聚合函数；省略表示返回原始字段。 */
    aggregation: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]).optional(),
    /** 已验证的返回列名称。 */
    as: aliasSchema,
  })
  .strict();

/** 最终排序项，仅接受声明字段。 */
const executableOrderBySchema = z
  .object({
    /** 规划器保留的排序字段引用。 */
    field: identifierSchema,
    /** 排序只允许两个固定方向。 */
    direction: z.enum(["asc", "desc"]),
  })
  .strict();

/** 交给 SQL 编译器的最终关系查询，仅接受声明字段。 */
const executableRelationalQuerySchema = z
  .object({
    /** 判别关系查询分支，连接器据此选择 SQL 编译路径。 */
    type: z.literal("relational_query"),
    /** 数据源管理器用此标识选择运行时连接器实例。 */
    source_id: z.string().min(1),
    /** 数据源配置的超时，单位毫秒，允许 100 毫秒至 120 秒；由驱动或客户端落实。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 按请求和数据源配置取较小值后的返回上限，最多十万行。 */
    row_limit: z.number().int().min(1).max(MAX_QUERY_ROWS),
    /** 主对象物理映射。 */
    from: executableFilteredRelationSchema,
    /** Join 对象物理映射。 */
    joins: z.array(executableJoinSchema),
    /** 从最终请求映射的查询级过滤条件。 */
    filters: executableFilterGroupSchema,
    /** API 已验证业务规则的结果列。 */
    select: z.array(executableSelectSchema).min(1),
    /** 已验证的分组字段。 */
    group_by: z.array(identifierSchema),
    /** 已验证的排序字段。 */
    order_by: z.array(executableOrderBySchema),
  })
  .strict()
  /**
   * 每个对象过滤和预聚合引用原始自身字段；外层仅能引用其派生输出。
   * 原始列存在性由 API 目录授权保证，DAS 在此复核关系作用域和每层可编译的分组语义。
   */
  .superRefine((query, context) => {
    const reject = (message: string) => context.addIssue({ code: "custom", message });
    const relations = [query.from, ...query.joins.map((join) => join.relation)];
    const aliases = relations.map((relation) => relation.alias);
    if (new Set(aliases).size !== aliases.length) reject("关系别名不能重复");
    const scopes = new Map<string, Set<string> | undefined>(
      relations.map((relation) => [
        relation.alias,
        relation.pre_aggregate
          ? new Set(relation.pre_aggregate.select.map((item) => item.as))
          : undefined,
      ]),
    );
    const assertField = (field: string, available: Map<string, Set<string> | undefined>) => {
      const parts = field.split(".");
      if (
        parts.length !== 2 ||
        !parts[1] ||
        !available.has(parts[0]) ||
        (available.get(parts[0]) !== undefined && !available.get(parts[0])!.has(parts[1]))
      )
        reject(`字段超出当前查询层的输出范围: ${field}`);
    };
    for (const relation of relations) {
      const rawScope = new Map([[relation.alias, undefined]]);
      if (relation.filters)
        validateFilterScope(relation.filters, (field) => assertField(field, rawScope));
      if (relation.pre_aggregate) {
        for (const field of relation.pre_aggregate.group_by) assertField(field, rawScope);
        for (const selection of relation.pre_aggregate.select)
          assertField(selection.field, rawScope);
      }
    }
    for (const [index, join] of query.joins.entries()) {
      const preceding = new Map(
        [...scopes].filter(([alias]) => aliases.slice(0, index + 1).includes(alias)),
      );
      const current = new Map([[join.relation.alias, scopes.get(join.relation.alias)]]);
      for (const condition of join.on) {
        assertField(condition.left, preceding);
        assertField(condition.right, current);
      }
      if (join.on_filters)
        validateFilterScope(join.on_filters, (field) =>
          assertField(field, new Map([...preceding, ...current])),
        );
    }
    validateFilterScope(query.filters, (field) => assertField(field, scopes));
    const outputs = new Set(query.select.map((selection) => selection.as));
    if (outputs.size !== query.select.length) reject("结果列别名不能重复");
    const groups = new Set(query.group_by);
    if (groups.size !== query.group_by.length) reject("分组字段不能重复");
    const isGrouped = groups.size > 0 || query.select.some((selection) => selection.aggregation);
    for (const field of query.group_by) assertField(field, scopes);
    for (const selection of query.select) {
      assertField(selection.field, scopes);
      if (isGrouped && !selection.aggregation && !groups.has(selection.field))
        reject(`非聚合结果字段必须属于当前层分组: ${selection.field}`);
    }
    for (const order of query.order_by) {
      if (!order.field.includes(".")) {
        if (!outputs.has(order.field)) reject(`排序结果别名不存在: ${order.field}`);
      } else {
        assertField(order.field, scopes);
        if (isGrouped && !groups.has(order.field))
          reject(`聚合查询排序字段必须属于当前层分组: ${order.field}`);
      }
    }
  });

/** 连接器执行前的最终关系查询类型。 */
type ExecutableRelationalQuery = z.infer<typeof executableRelationalQuerySchema>;

/** 固定对象调用的一条绑定参数，仅接受声明字段，并检查 value 与 data_type 一致。 */
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

/** 固定存储过程或 HTTP 虚拟表的参数化调用计划，仅接受声明字段。 */
const executableParameterizedQuerySchema = z
  .object({
    /** 判别固定存储过程或 HTTP API 的参数化执行分支。 */
    type: z.literal("parameterized_query"),
    /** 数据源管理器据此选择运行时连接器。 */
    source_id: z.string().min(1),
    /** 数据源配置的超时，单位毫秒，允许 100 毫秒至 120 秒；由驱动或客户端落实。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 按请求和数据源配置取较小值后的返回上限，最多十万行。 */
    row_limit: z.number().int().min(1).max(MAX_QUERY_ROWS),
    /** 已映射到固定存储过程或 API 虚拟表的对象。 */
    from: executableRelationSchema,
    /** API 已完成业务校验的调用参数。 */
    parameters: z.array(executableParameterSchema),
    /** 规划器核对签名后确定的本地完整输出定义；固定调用执行前要求存在。 */
    fixed_output: z.array(datasetColumnSchema).min(1).optional(),
    /** PostgreSQL OUT-only 参数的位置和类型，由本地管理员定义产生。 */
    procedure_output_parameters: z.array(procedureOutputParameterSchema).optional(),
    /** PostgreSQL 输入参数使用白名单原生类型显式转换，以确定过程签名。 */
    procedure_parameter_types: z.array(postgresqlParameterTypeSchema).optional(),
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

/** 递归遍历筛选叶子，所有嵌套组遵守所在查询层的字段作用域。 */
function validateFilterScope(
  group: ExecutableFilterGroup,
  assertField: (field: string) => void,
): void {
  for (const item of group.items) {
    if ("items" in item) validateFilterScope(item, assertField);
    else assertField(item.field);
  }
}

export {
  executableFilterConditionSchema,
  executableFilterGroupSchema,
  executableParameterizedQuerySchema,
  executableQuerySchema,
  executableRelationalQuerySchema,
  executableRelationSchema,
};

export type {
  ExecutableFilteredRelation,
  ExecutableFilter,
  ExecutableFilterGroup,
  ExecutableParameterizedQuery,
  ExecutableQuery,
  ExecutableRelation,
  ExecutableRelationalQuery,
};
