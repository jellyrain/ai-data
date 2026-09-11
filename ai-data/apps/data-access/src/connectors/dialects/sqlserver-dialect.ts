import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

function quoteSqlServerIdentifier(identifier: string): string {
  return `[${identifier.replaceAll("]", "]]")}]`;
}

/** SQL Server 方言。 */
const sqlServerDialect: DatabaseDialect = {
  kind: "sqlserver",
  quoteIdentifier: quoteSqlServerIdentifier,
  relationAliasSql: (alias: string) => ` AS ${quoteSqlServerIdentifier(alias)}`,
  parameterPlaceholder: (index: number) => `@p${index}`,
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `CONVERT(date, ${placeholder}, 23)`;
    if (dataType === "datetime") return `CONVERT(datetime2, ${placeholder}, 120)`;
    return placeholder;
  },
  healthSql: () => "SELECT 1 AS das_health",
  catalogSql: () => `
    SELECT
      t.TABLE_SCHEMA AS schema_name,
      t.TABLE_NAME AS object_name,
      CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
      c.COLUMN_NAME AS column_name,
      c.DATA_TYPE AS data_type,
      c.IS_NULLABLE AS is_nullable,
      c.ORDINAL_POSITION AS ordinal_position
    FROM INFORMATION_SCHEMA.TABLES t
    JOIN INFORMATION_SCHEMA.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
      AND c.TABLE_NAME = t.TABLE_NAME
    WHERE t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
    UNION ALL
    SELECT
      s.name AS schema_name,
      p.name AS object_name,
      'stored_procedure' AS object_kind,
      NULL AS column_name,
      NULL AS data_type,
      NULL AS is_nullable,
      NULL AS ordinal_position
    FROM sys.procedures p
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    WHERE p.is_ms_shipped = 0
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  procedureSql: (relation, parameterNames) =>
    `EXEC ${renderPhysicalName(relation, quoteSqlServerIdentifier)} ${parameterNames.map((name, index) => `@${name} = @p${index}`).join(", ")}`,
  limitSql: () => "",
  selectLimitSql: (limit: number) => `TOP ${limit} `,
};

export { sqlServerDialect };
