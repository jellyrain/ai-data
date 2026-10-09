import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

/** 使用方括号引用名称，将名称内部的右方括号成对转义。 */
function quoteSqlServerIdentifier(identifier: string): string {
  return `[${identifier.replaceAll("]", "]]")}]`;
}

/** SQL Server 的标识符、参数绑定和固定查询模板实现。 */
const sqlServerDialect: DatabaseDialect = {
  kind: "sqlserver",
  quoteIdentifier: quoteSqlServerIdentifier,
  relationAliasSql: (alias: string) => ` AS ${quoteSqlServerIdentifier(alias)}`,
  parameterPlaceholder: (index: number) => `@p${index}`,
  // 日期文本按 23（日期）和 120（秒级时间）样式显式转换。
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `CONVERT(date, ${placeholder}, 23)`;
    if (dataType === "datetime") return `CONVERT(datetime2, ${placeholder}, 120)`;
    return placeholder;
  },
  healthSql: () => "SELECT 1 AS das_health",
  // 目录行统一字段别名；存储过程只发现对象名，列与参数元数据由后续目录能力补充。
  catalogSql: () => `
    SELECT
      t.TABLE_SCHEMA AS schema_name,
      t.TABLE_NAME AS object_name,
      CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS object_kind,
      c.COLUMN_NAME AS column_name,
      c.DATA_TYPE AS data_type,
      c.IS_NULLABLE AS is_nullable,
      c.ORDINAL_POSITION AS ordinal_position,
      CONVERT(nvarchar(max), object_note.value) AS object_description,
      CONVERT(nvarchar(max), column_note.value) AS column_description
    FROM INFORMATION_SCHEMA.TABLES t
    JOIN INFORMATION_SCHEMA.COLUMNS c
      ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
      AND c.TABLE_NAME = t.TABLE_NAME
    LEFT JOIN sys.schemas s ON s.name = t.TABLE_SCHEMA
    LEFT JOIN sys.objects o ON o.schema_id = s.schema_id AND o.name = t.TABLE_NAME
    LEFT JOIN sys.columns sc ON sc.object_id = o.object_id AND sc.name = c.COLUMN_NAME
    LEFT JOIN sys.extended_properties object_note
      ON object_note.class = 1 AND object_note.major_id = o.object_id
      AND object_note.minor_id = 0 AND object_note.name = N'MS_Description'
    LEFT JOIN sys.extended_properties column_note
      ON column_note.class = 1 AND column_note.major_id = o.object_id
      AND column_note.minor_id = sc.column_id AND column_note.name = N'MS_Description'
    WHERE t.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
    UNION ALL
    SELECT
      s.name AS schema_name,
      p.name AS object_name,
      'stored_procedure' AS object_kind,
      NULL AS column_name,
      NULL AS data_type,
      NULL AS is_nullable,
      NULL AS ordinal_position,
      CONVERT(nvarchar(max), object_note.value) AS object_description,
      NULL AS column_description
    FROM sys.procedures p
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    LEFT JOIN sys.extended_properties object_note
      ON object_note.class = 1 AND object_note.major_id = p.object_id
      AND object_note.minor_id = 0 AND object_note.name = N'MS_Description'
    WHERE p.is_ms_shipped = 0
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  // 按参数名调用固定存储过程，值使用 @p 序号绑定。
  procedureSql: (relation, parameterNames) =>
    `EXEC ${renderPhysicalName(relation, quoteSqlServerIdentifier)} ${parameterNames.map((name, index) => `@${name} = @p${index}`).join(", ")}`,
  // SQL Server 的行数限制放在 SELECT 后的 TOP 子句。
  limitSql: () => "",
  selectLimitSql: (limit: number) => `TOP ${limit} `,
};

export { sqlServerDialect };
