import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

function quoteOracleIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Oracle 方言。 */
const oracleDialect: DatabaseDialect = {
  kind: "oracle",
  quoteIdentifier: quoteOracleIdentifier,
  relationAliasSql: (alias: string) => ` ${quoteOracleIdentifier(alias)}`,
  parameterPlaceholder: (index: number) => `:p${index}`,
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `TO_DATE(${placeholder}, 'YYYY-MM-DD')`;
    if (dataType === "datetime") return `TO_TIMESTAMP(${placeholder}, 'YYYY-MM-DD HH24:MI:SS')`;
    return placeholder;
  },
  healthSql: () => "SELECT 1 AS das_health FROM dual",
  catalogSql: () => `
    SELECT c.owner AS schema_name, c.table_name AS object_name,
      CASE WHEN o.object_type = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
      c.column_name, c.data_type, c.nullable AS is_nullable,
      c.column_id AS ordinal_position
    FROM ALL_TAB_COLUMNS c
    JOIN ALL_OBJECTS o ON o.owner = c.owner AND o.object_name = c.table_name
    WHERE o.object_type IN ('TABLE', 'VIEW')
      AND o.owner NOT IN ('SYS', 'SYSTEM')
    UNION ALL
    SELECT
      p.owner AS schema_name,
      p.object_name AS object_name,
      'stored_procedure' AS object_kind,
      NULL AS column_name,
      NULL AS data_type,
      NULL AS is_nullable,
      NULL AS ordinal_position
    FROM all_procedures p
    WHERE p.object_type = 'PROCEDURE'
      AND p.owner NOT IN ('SYS', 'SYSTEM')
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  procedureSql: (relation, parameterNames) =>
    `BEGIN ${renderPhysicalName(relation, quoteOracleIdentifier)}(${parameterNames.map((_, index) => `:p${index}`).join(", ")}); END;`,
  limitSql: (limit: number) => `FETCH FIRST ${limit} ROWS ONLY`,
  selectLimitSql: () => "",
};

export { oracleDialect };
