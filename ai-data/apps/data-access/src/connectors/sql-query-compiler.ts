import type {
  ExecutableFilter,
  ExecutableFilterGroup,
  ExecutableParameterizedQuery,
  ExecutableRelation,
  ExecutableRelationalQuery,
} from "./executable-query";
import type { DatabaseParameter } from "./database-connector";
import type { DatabaseDialect } from "./dialects/database-dialect";
import type { ParameterDataType } from "./dialects/database-dialect";

type CompiledSqlQuery = {
  sql: string;
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

function compileRelationalQuery(
  query: ExecutableRelationalQuery,
  dialect: DatabaseDialect,
): CompiledSqlQuery {
  const parameters: DatabaseParameter[] = [];
  const select = query.select
    .map(
      (item) =>
        `${renderSelection(item.field, item.aggregation, dialect)} AS ${quoteName(item.as, dialect)}`,
    )
    .join(", ");
  const sqlParts = [`SELECT ${dialect.selectLimitSql(query.row_limit)}${select}`];
  sqlParts.push(`FROM ${renderRelation(query.from, dialect)}`);

  for (const join of query.joins) {
    const conditions = join.on
      .map(
        (condition) =>
          `${renderField(condition.left, dialect)} = ${renderField(condition.right, dialect)}`,
      )
      .join(" AND ");
    sqlParts.push(
      `${join.type.toUpperCase()} JOIN ${renderRelation(join.relation, dialect)} ON ${conditions}`,
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
  const limit = dialect.limitSql(query.row_limit);
  if (limit !== "") sqlParts.push(limit);
  return { sql: sqlParts.join(" "), parameters };
}

function compileParameterizedQuery(
  query: ExecutableParameterizedQuery,
  dialect: DatabaseDialect,
): CompiledSqlQuery {
  const parameters = query.parameters.map((parameter) =>
    toDatabaseParameter(parameter.value, parameter.data_type),
  );
  return {
    sql: dialect.procedureSql(
      query.from,
      query.parameters.map((parameter) => parameter.name),
    ),
    parameters,
  };
}

function renderRelation(relation: ExecutableRelation, dialect: DatabaseDialect): string {
  const physical = relation.native_schema_name
    ? `${quoteName(relation.native_schema_name, dialect)}.${quoteName(relation.native_object_name, dialect)}`
    : quoteName(relation.native_object_name, dialect);
  return `${physical}${dialect.relationAliasSql(relation.alias)}`;
}

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
      return `AVG(${rendered})`;
    case "min":
      return `MIN(${rendered})`;
    case "max":
      return `MAX(${rendered})`;
    default:
      return rendered;
  }
}

function renderFilterGroup(
  group: ExecutableFilterGroup,
  dialect: DatabaseDialect,
  parameters: DatabaseParameter[],
  root = false,
): string | undefined {
  if (group.items.length === 0) return root ? undefined : group.logic === "and" ? "1 = 1" : "1 = 0";
  const items = group.items.map((item) =>
    "items" in item
      ? renderFilterGroup(item, dialect, parameters)
      : renderFilter(item, dialect, parameters),
  );
  return `(${items.join(` ${group.logic.toUpperCase()} `)})`;
}

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

function addParameter(
  value: unknown,
  dataType: ParameterDataType,
  dialect: DatabaseDialect,
  parameters: DatabaseParameter[],
): string {
  const index = parameters.push(toDatabaseParameter(value, dataType)) - 1;
  return dialect.parameterSql(dialect.parameterPlaceholder(index), dataType);
}

function toDatabaseParameter(value: unknown, dataType: ParameterDataType): DatabaseParameter {
  if (value === null) return { value, dataType };
  if (dataType === "buffer" && typeof value === "string")
    return { value: Buffer.from(value, "base64"), dataType };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return { value, dataType };
  throw new Error("查询参数必须是数据库驱动支持的基础值");
}

function renderField(field: string, dialect: DatabaseDialect): string {
  return field
    .split(".")
    .map((part) => quoteName(part, dialect))
    .join(".");
}

function quoteName(identifier: string, dialect: DatabaseDialect): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`标识符不安全: ${identifier}`);
  }
  return dialect.quoteIdentifier(identifier);
}

export { compileSqlQuery, toDatabaseParameter };
export type { CompiledSqlQuery };
