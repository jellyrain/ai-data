import { renderPhysicalName, type DatabaseDialect } from "./database-dialect";

/** 使用反引号引用名称，并转义名称内部的反引号。 */
function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

/** MySQL 的标识符、参数绑定和固定查询模板实现。 */
const mysqlDialect: DatabaseDialect = {
  kind: "mysql",
  quoteIdentifier: quoteMysqlIdentifier,
  relationAliasSql: (alias: string) => ` AS ${quoteMysqlIdentifier(alias)}`,
  parameterPlaceholder: () => "?",
  // 按合同的日期或秒级时间格式解析绑定文本。
  parameterSql: (placeholder, dataType) => {
    if (dataType === "date") return `STR_TO_DATE(${placeholder}, '%Y-%m-%d')`;
    if (dataType === "datetime") return `STR_TO_DATE(${placeholder}, '%Y-%m-%d %H:%i:%s')`;
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
      CASE WHEN c.DATA_TYPE = 'bit' THEN c.COLUMN_TYPE ELSE c.DATA_TYPE END AS data_type,
      c.IS_NULLABLE AS is_nullable,
      c.ORDINAL_POSITION AS ordinal_position,
      CASE WHEN t.TABLE_TYPE = 'VIEW' THEN NULL ELSE t.TABLE_COMMENT END AS object_description,
      c.COLUMN_COMMENT AS column_description
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
      NULL AS ordinal_position,
      r.ROUTINE_COMMENT AS object_description,
      NULL AS column_description
    FROM INFORMATION_SCHEMA.ROUTINES r
    WHERE r.ROUTINE_SCHEMA = DATABASE()
      AND r.ROUTINE_TYPE = 'PROCEDURE'
    ORDER BY schema_name, object_name, ordinal_position;
  `,
  // CALL 的问号按出现顺序与驱动参数数组对应。
  procedureSql: (relation, parameterNames) =>
    `CALL ${renderPhysicalName(relation, quoteMysqlIdentifier)}(${parameterNames.map(() => "?").join(", ")})`,
  // MySQL 将行数限制放在查询尾部。
  limitSql: (limit: number) => `LIMIT ${limit}`,
  selectLimitSql: () => "",
};

export { mysqlDialect };
