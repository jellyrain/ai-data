import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

/** 使用双引号引用名称，并转义名称内部的双引号。 */
function quoteOracleIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Oracle 的标识符、参数绑定和固定查询模板实现。 */
const oracleDialect: DatabaseDialect = {
  kind: "oracle",
  quoteIdentifier: quoteOracleIdentifier,
  relationAliasSql: (alias: string) => ` ${quoteOracleIdentifier(alias)}`,
  parameterPlaceholder: (index: number) => `:p${index}`,
  // 使用明确的日期和时间格式解析文本，保持合同的秒级时间语义。
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `TO_DATE(${placeholder}, 'YYYY-MM-DD')`;
    if (dataType === "datetime") return `TO_TIMESTAMP(${placeholder}, 'YYYY-MM-DD HH24:MI:SS')`;
    return placeholder;
  },
  healthSql: () => "SELECT 1 AS das_health FROM dual",
  // 目录行统一字段别名；存储过程只发现对象名，列与参数元数据由后续目录能力补充。
  catalogSql: () => `
    SELECT c.owner AS schema_name, c.table_name AS object_name,
      CASE WHEN o.object_type = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
      c.column_name, c.data_type, c.nullable AS is_nullable,
      c.column_id AS ordinal_position,
      object_note.comments AS object_description,
      column_note.comments AS column_description
    FROM ALL_TAB_COLUMNS c
    JOIN ALL_OBJECTS o ON o.owner = c.owner AND o.object_name = c.table_name
    LEFT JOIN ALL_TAB_COMMENTS object_note
      ON object_note.owner = c.owner AND object_note.table_name = c.table_name
    LEFT JOIN ALL_COL_COMMENTS column_note
      ON column_note.owner = c.owner AND column_note.table_name = c.table_name
      AND column_note.column_name = c.column_name
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
      NULL AS ordinal_position,
      NULL AS object_description,
      NULL AS column_description
    FROM all_procedures p
    WHERE p.object_type = 'PROCEDURE'
      AND p.owner NOT IN ('SYS', 'SYSTEM')
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  // 在匿名块中调用固定对象，按数组顺序绑定命名占位符。
  procedureSql: (relation, parameterNames) =>
    `BEGIN ${renderPhysicalName(relation, quoteOracleIdentifier)}(${parameterNames.map((_, index) => `:p${index}`).join(", ")}); END;`,
  // Oracle 将行数限制放在查询尾部的 FETCH FIRST 子句。
  limitSql: (limit: number) => `FETCH FIRST ${limit} ROWS ONLY`,
  selectLimitSql: () => "",
};

export { oracleDialect };
