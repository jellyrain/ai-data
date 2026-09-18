import type {
  ExecutableFilter,
  ExecutableFilterGroup,
  ExecutableParameterizedQuery,
  ExecutableFilteredRelation,
  ExecutableRelationalQuery,
} from "./executable-query";
import type { DatabaseParameter } from "./database-connector";
import type { DatabaseDialect } from "./dialects/database-dialect";
import type { ParameterDataType } from "./dialects/database-dialect";
import { postgresqlParameterTypeSchema } from "../catalog/procedure-definition";

/** 方言编译结果；SQL 模板与动态值分开交给驱动。 */
type CompiledSqlQuery = {
  /** 含占位符的查询或固定对象调用语句。 */
  sql: string;
  /** 按占位符出现顺序排列的绑定值及类型。 */
  parameters: DatabaseParameter[];
};

/** 将已规划的最终 DSL 编译为方言参数化 SQL。 */
function compileSqlQuery(
  query: ExecutableRelationalQuery | ExecutableParameterizedQuery,
  dialect: DatabaseDialect,
): CompiledSqlQuery {
  if (query.type === "parameterized_query") {
    return compileParameterizedQuery(query, dialect);
  }
  return compileRelationalQuery(query, dialect);
}

/** 按最终 DSL 组装关系查询；多读取一行供连接器判断是否截断。 */
function compileRelationalQuery(
  query: ExecutableRelationalQuery,
  dialect: DatabaseDialect,
): CompiledSqlQuery {
  const parameters: DatabaseParameter[] = [];
  // row_limit 是对外返回上限，额外探测行只用于判断是否还有结果。
  const readLimit = query.row_limit + 1;
  const select = query.select
    .map(
      (item) =>
        `${renderSelection(item.field, item.aggregation, dialect)} AS ${quoteName(item.as, dialect)}`,
    )
    .join(", ");
  const sqlParts = [`SELECT ${dialect.selectLimitSql(readLimit)}${select}`];
  sqlParts.push(`FROM ${renderRelation(query.from, dialect, parameters)}`);

  for (const join of query.joins) {
    const conditions = join.on
      .map(
        (condition) =>
          `${renderField(condition.left, dialect)} = ${renderField(condition.right, dialect)}`,
      )
      .join(" AND ");
    // 占位参数严格按 SQL 文本顺序注册：对象输入在前，ON 条件在后。
    const relation = renderRelation(join.relation, dialect, parameters);
    const onFilters = join.on_filters
      ? renderFilterGroup(join.on_filters, dialect, parameters)
      : undefined;
    sqlParts.push(
      `${join.type.toUpperCase()} JOIN ${relation} ON ${conditions}${onFilters === undefined ? "" : ` AND ${onFilters}`}`,
    );
  }

  const filterSql = renderFilterGroup(query.filters, dialect, parameters, true);
  if (filterSql !== undefined) sqlParts.push(`WHERE ${filterSql}`);
  if (query.group_by.length > 0) {
    sqlParts.push(
      `GROUP BY ${query.group_by.map((field) => renderField(field, dialect)).join(", ")}`,
    );
  }
  if (query.order_by.length > 0) {
    sqlParts.push(
      `ORDER BY ${query.order_by
        .map((item) => `${renderField(item.field, dialect)} ${item.direction.toUpperCase()}`)
        .join(", ")}`,
    );
  }
  const limit = dialect.limitSql(readLimit);
  if (limit !== "") sqlParts.push(limit);
  return { sql: sqlParts.join(" "), parameters };
}

/** 将固定对象的调用参数按原顺序绑定，由方言决定调用语法。 */
function compileParameterizedQuery(
  query: ExecutableParameterizedQuery,
  dialect: DatabaseDialect,
): CompiledSqlQuery {
  if (dialect.kind === "oracle") throw new Error("Oracle 存储过程的原生结果集调用尚未支持");
  const parameters = query.parameters.map((parameter) =>
    toDatabaseParameter(parameter.value, parameter.data_type),
  );
  if (dialect.kind === "postgresql") {
    const types = query.procedure_parameter_types ?? [];
    if (types.length !== parameters.length)
      throw new Error("PostgreSQL 过程需要配置完整原生参数类型");
    const outputParameters = query.procedure_output_parameters ?? [];
    const total = parameters.length + outputParameters.length;
    if (
      new Set(outputParameters.map((parameter) => parameter.position)).size !==
        outputParameters.length ||
      outputParameters.some((parameter) => parameter.position < 0 || parameter.position >= total)
    ) {
      throw new Error("过程输出参数位置无效");
    }
    let inputIndex = 0;
    const argumentsSql = Array.from({ length: total }, (_, position) => {
      const output = outputParameters.find((parameter) => parameter.position === position);
      if (output !== undefined) return "NULL";
      const nativeType = postgresqlParameterTypeSchema.parse(types[inputIndex]);
      return `$${++inputIndex}::${nativeType}`;
    });
    const name =
      query.from.native_schema_name === undefined
        ? quoteName(query.from.native_object_name, dialect)
        : `${quoteName(query.from.native_schema_name, dialect)}.${quoteName(query.from.native_object_name, dialect)}`;
    return { sql: `CALL ${name}(${argumentsSql.join(", ")})`, parameters };
  }
  return {
    sql: dialect.procedureSql(
      query.from,
      query.parameters.map((parameter) => parameter.name),
    ),
    parameters,
  };
}

/** 对象原始行先执行授权过滤，再完成对象分组；每层对象输出整体参与外层关联。 */
function renderRelation(
  relation: ExecutableFilteredRelation,
  dialect: DatabaseDialect,
  parameters: DatabaseParameter[],
): string {
  const physical = relation.native_schema_name
    ? `${quoteName(relation.native_schema_name, dialect)}.${quoteName(relation.native_object_name, dialect)}`
    : quoteName(relation.native_object_name, dialect);
  const alias = dialect.relationAliasSql(relation.alias);
  const filters =
    relation.filters === undefined
      ? undefined
      : renderFilterGroup(relation.filters, dialect, parameters, true);
  if (relation.pre_aggregate) {
    // 对象层不使用行数限制，保证全部分组都能参与之后的关联与最终聚合。
    const selected = relation.pre_aggregate.select
      .map(
        (item) =>
          `${renderSelection(item.field, item.aggregation, dialect)} AS ${quoteName(item.as, dialect)}`,
      )
      .join(", ");
    const grouped = relation.pre_aggregate.group_by
      .map((field) => renderField(field, dialect))
      .join(", ");
    return `(SELECT ${selected} FROM ${physical}${alias}${filters === undefined ? "" : ` WHERE ${filters}`} GROUP BY ${grouped})${alias}`;
  }
  return filters === undefined
    ? `${physical}${alias}`
    : `(SELECT * FROM ${physical}${alias} WHERE ${filters})${alias}`;
}

/** 将受控聚合枚举映射为 SQL 函数；count_distinct 对字段值去重计数。 */
function renderSelection(
  field: string,
  aggregation: "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | undefined,
  dialect: DatabaseDialect,
): string {
  const rendered = renderField(field, dialect);
  switch (aggregation) {
    case "count":
      return `COUNT(${rendered})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${rendered})`;
    case "sum":
      return `SUM(${rendered})`;
    case "avg":
      // SQL Server 对整数 AVG 返回整数；FLOAT(53) 与公共 decimal 的 JS 双精度数值语义对齐。
      return dialect.kind === "sqlserver"
        ? `AVG(CAST(${rendered} AS FLOAT(53)))`
        : `AVG(${rendered})`;
    case "min":
      return `MIN(${rendered})`;
    case "max":
      return `MAX(${rendered})`;
    default:
      return rendered;
  }
}

/**
 * 用括号保留 AND/OR 树的分组语义。
 * 空 AND 为真，根级可省略 WHERE；空 OR 为假，始终保留拒绝全部记录的语义。
 */
function renderFilterGroup(
  group: ExecutableFilterGroup,
  dialect: DatabaseDialect,
  parameters: DatabaseParameter[],
  root = false,
): string | undefined {
  if (group.items.length === 0) return group.logic === "or" ? "1 = 0" : root ? undefined : "1 = 1";
  const items = group.items.map((item) =>
    "items" in item
      ? renderFilterGroup(item, dialect, parameters)
      : renderFilter(item, dialect, parameters),
  );
  return `(${items.join(` ${group.logic.toUpperCase()} `)})`;
}

/** 将已校验的操作符映射为条件；数组元素和范围端点分别绑定，空值判断无需参数。 */
function renderFilter(
  condition: ExecutableFilter,
  dialect: DatabaseDialect,
  parameters: DatabaseParameter[],
): string {
  const field = renderField(condition.field, dialect);
  switch (condition.op) {
    case "is_null":
      return `${field} IS NULL`;
    case "not_null":
      return `${field} IS NOT NULL`;
    case "in":
    case "not_in": {
      const values = condition.value as unknown[];
      const placeholders = values.map((value) =>
        addParameter(value, condition.data_type, dialect, parameters),
      );
      return `${field} ${condition.op === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`;
    }
    case "between": {
      const values = condition.value as unknown[];
      return `${field} BETWEEN ${addParameter(values[0], condition.data_type, dialect, parameters)} AND ${addParameter(values[1], condition.data_type, dialect, parameters)}`;
    }
    case "eq":
    case "neq": {
      const operator = condition.op === "eq" ? "=" : "<>";
      return `${field} ${operator} ${addParameter(condition.value, condition.data_type, dialect, parameters)}`;
    }
  }
}

/** 追加绑定值后取得零基序号，使占位符顺序与驱动收到的参数数组一致。 */
function addParameter(
  value: unknown,
  dataType: ParameterDataType,
  dialect: DatabaseDialect,
  parameters: DatabaseParameter[],
): string {
  const index = parameters.push(toDatabaseParameter(value, dataType)) - 1;
  return dialect.parameterSql(dialect.parameterPlaceholder(index), dataType);
}

/** 将合同中的 Base64 转回驱动二进制值；日期文本保留给方言表达式转换。 */
function toDatabaseParameter(value: unknown, dataType: ParameterDataType): DatabaseParameter {
  if (value === null) return { value, dataType };
  if (dataType === "buffer" && typeof value === "string")
    return { value: Buffer.from(value, "base64"), dataType };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return { value, dataType };
  throw new Error("查询参数必须是数据库驱动支持的基础值");
}

/** 按点号拆分对象别名与字段名，分别引用，避免把整段限定名当作单个字段。 */
function renderField(field: string, dialect: DatabaseDialect): string {
  return field
    .split(".")
    .map((part) => quoteName(part, dialect))
    .join(".");
}

/** 编译前再次限定单段标识符的字符形式，再交给方言转义引用。 */
function quoteName(identifier: string, dialect: DatabaseDialect): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`标识符不安全: ${identifier}`);
  }
  return dialect.quoteIdentifier(identifier);
}

export { compileSqlQuery, toDatabaseParameter };
export type { CompiledSqlQuery };
