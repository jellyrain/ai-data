import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

/** MySQL 方言。 */
const mysqlDialect: DatabaseDialect = {
  kind: "mysql",
  quoteIdentifier: quoteMysqlIdentifier,
  relationAliasSql: (alias: string) => ` AS ${quoteMysqlIdentifier(alias)}`,
  parameterPlaceholder: () => "?",
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `STR_TO_DATE(${placeholder}, '%Y-%m-%d')`;
    if (dataType === "datetime") return `STR_TO_DATE(${placeholder}, '%Y-%m-%d %H:%i:%s')`;
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
    WHERE t.TABLE_SCHEMA = DATABASE()
    UNION ALL
    SELECT
      r.ROUTINE_SCHEMA AS schema_name,
      r.ROUTINE_NAME AS object_name,
      'stored_procedure' AS object_kind,
      NULL AS column_name,
      NULL AS data_type,
      NULL AS is_nullable,
      NULL AS ordinal_position
    FROM INFORMATION_SCHEMA.ROUTINES r
    WHERE r.ROUTINE_SCHEMA = DATABASE()
      AND r.ROUTINE_TYPE = 'PROCEDURE'
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  procedureSql: (relation, parameterNames) =>
    `CALL ${renderPhysicalName(relation, quoteMysqlIdentifier)}(${parameterNames.map(() => "?").join(", ")})`,
  limitSql: (limit: number) => `LIMIT ${limit}`,
  selectLimitSql: () => "",
};

export { mysqlDialect };
