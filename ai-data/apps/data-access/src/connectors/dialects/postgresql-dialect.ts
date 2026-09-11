import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

function quotePostgresqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** PostgreSQL 方言。 */
const postgresqlDialect: DatabaseDialect = {
  kind: "postgresql",
  quoteIdentifier: quotePostgresqlIdentifier,
  relationAliasSql: (alias: string) => ` AS ${quotePostgresqlIdentifier(alias)}`,
  parameterPlaceholder: (index: number) => `$${index + 1}`,
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `${placeholder}::date`;
    if (dataType === "datetime") return `${placeholder}::timestamp`;
    return placeholder;
  },
  healthSql: () => "SELECT 1 AS das_health",
  catalogSql: () => `
    SELECT
      t.table_schema AS schema_name,
      t.table_name AS object_name,
      CASE WHEN t.table_type = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.ordinal_position AS ordinal_position
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema = t.table_schema
      AND c.table_name = t.table_name
    WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
    UNION ALL
    SELECT
      r.routine_schema AS schema_name,
      r.routine_name AS object_name,
      'stored_procedure' AS object_kind,
      NULL AS column_name,
      NULL AS data_type,
      NULL AS is_nullable,
      NULL AS ordinal_position
    FROM information_schema.routines r
    WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema')
      AND r.routine_type = 'PROCEDURE'
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  procedureSql: (relation, parameterNames) =>
    `SELECT * FROM ${renderPhysicalName(relation, quotePostgresqlIdentifier)}(${parameterNames.map((_, index) => `$${index + 1}`).join(", ")})`,
  limitSql: (limit: number) => `LIMIT ${limit}`,
  selectLimitSql: () => "",
};

export { postgresqlDialect };
