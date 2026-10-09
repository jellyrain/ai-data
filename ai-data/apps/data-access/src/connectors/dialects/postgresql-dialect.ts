import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

/** 使用双引号引用名称，并转义名称内部的双引号。 */
function quotePostgresqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** PostgreSQL 的标识符、参数绑定和固定查询模板实现。 */
const postgresqlDialect: DatabaseDialect = {
  kind: "postgresql",
  quoteIdentifier: quotePostgresqlIdentifier,
  relationAliasSql: (alias: string) => ` AS ${quotePostgresqlIdentifier(alias)}`,
  parameterPlaceholder: (index: number) => `$${index + 1}`,
  // 为日期与时间绑定文本添加显式类型转换。
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `${placeholder}::date`;
    if (dataType === "datetime") return `${placeholder}::timestamp`;
    return placeholder;
  },
  healthSql: () => "SELECT 1 AS das_health",
  // 过程发现提供物理标识，输入签名及固定输出由本地管理员审核定义补齐。
  catalogSql: () => `
    SELECT
      t.table_schema AS schema_name,
      t.table_name AS object_name,
      CASE WHEN t.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.ordinal_position AS ordinal_position,
      pg_catalog.obj_description(o.oid, 'pg_class') AS object_description,
      pg_catalog.col_description(o.oid, a.attnum) AS column_description
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema = t.table_schema
      AND c.table_name = t.table_name
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
    LEFT JOIN pg_catalog.pg_class o ON o.relnamespace = n.oid AND o.relname = t.table_name
    LEFT JOIN pg_catalog.pg_attribute a
      ON a.attrelid = o.oid AND a.attname = c.column_name AND a.attnum > 0 AND NOT a.attisdropped
    WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
    UNION ALL
    SELECT
      r.routine_schema AS schema_name,
      r.routine_name AS object_name,
      'stored_procedure' AS object_kind,
      NULL AS column_name,
      NULL AS data_type,
      NULL AS is_nullable,
      NULL AS ordinal_position,
      NULL::text AS object_description,
      NULL::text AS column_description
    FROM information_schema.routines r
    WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema')
      AND r.routine_type = 'PROCEDURE'
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  // 目录中的真实 PROCEDURE 通过 CALL 执行，OUT 占位由编译器按受控定义补齐。
  procedureSql: (relation, parameterNames) =>
    `CALL ${renderPhysicalName(relation, quotePostgresqlIdentifier)}(${parameterNames.map((_, index) => `$${index + 1}`).join(", ")})`,
  // PostgreSQL 将行数限制放在查询尾部。
  limitSql: (limit: number) => `LIMIT ${limit}`,
  selectLimitSql: () => "",
};

export { postgresqlDialect };
