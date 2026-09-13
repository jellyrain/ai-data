import { describe, expect, it } from "vitest";

import { mysqlDialect, oracleDialect, sqlServerDialect } from "../../src/connectors/dialects";
import {
  executableQuerySchema,
  type ExecutableRelationalQuery,
} from "../../src/connectors/executable-query";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";

/** 组合 Join、聚合和嵌套过滤，复用于不同方言的 SQL 与参数顺序断言。 */
function relationalQuery(): ExecutableRelationalQuery {
  const query = executableQuerySchema.parse({
    type: "relational_query",
    source_id: "clinical",
    timeout_ms: 12000,
    row_limit: 50,
    from: {
      object_id: "clinical.visit",
      native_schema_name: "dbo",
      native_object_name: "visit",
      alias: "v",
    },
    joins: [
      {
        type: "inner",
        relation: {
          object_id: "clinical.patient",
          native_schema_name: "dbo",
          native_object_name: "patient",
          alias: "p",
        },
        on: [{ left: "v.patient_id", op: "eq", right: "p.id" }],
      },
    ],
    filters: {
      logic: "and",
      items: [
        { field: "v.department_id", op: "eq", data_type: "string", value: "GYN" },
        {
          logic: "or",
          items: [
            { field: "p.status", op: "in", data_type: "string", value: ["active", "pending"] },
            { field: "p.deleted_at", op: "is_null", data_type: "datetime" },
          ],
        },
      ],
    },
    select: [
      { field: "v.id", as: "visit_id" },
      { field: "p.id", aggregation: "count", as: "patient_count" },
    ],
    group_by: ["v.id"],
    order_by: [{ field: "v.id", direction: "desc" }],
  });
  if (query.type !== "relational_query") throw new Error("测试查询类型错误");
  return query;
}

// 编译结果只在内存中比较 SQL 与绑定参数；各方言共用相同 DSL 样本。
describe("SQL 查询编译器", () => {
  it("编译 SQL Server 关系查询和嵌套筛选", () => {
    const result = compileSqlQuery(relationalQuery(), sqlServerDialect);

    expect(result.sql).toBe(
      "SELECT TOP 51 [v].[id] AS [visit_id], COUNT([p].[id]) AS [patient_count] FROM [dbo].[visit] AS [v] INNER JOIN [dbo].[patient] AS [p] ON [v].[patient_id] = [p].[id] WHERE ([v].[department_id] = @p0 AND ([p].[status] IN (@p1, @p2) OR [p].[deleted_at] IS NULL)) GROUP BY [v].[id] ORDER BY [v].[id] DESC",
    );
    expect(result.parameters).toEqual([
      { value: "GYN", dataType: "string" },
      { value: "active", dataType: "string" },
      { value: "pending", dataType: "string" },
    ]);
  });

  it("按 MySQL 方言生成反引号标识符和 LIMIT", () => {
    const result = compileSqlQuery(relationalQuery(), mysqlDialect);

    expect(result.sql).toContain("SELECT `v`.`id` AS `visit_id`");
    expect(result.sql).toContain("`p`.`status` IN (?, ?)");
    expect(result.sql.endsWith("ORDER BY `v`.`id` DESC LIMIT 51")).toBe(true);
    expect(result.parameters).toEqual([
      { value: "GYN", dataType: "string" },
      { value: "active", dataType: "string" },
      { value: "pending", dataType: "string" },
    ]);
  });

  it("按 Oracle 方言生成关系别名和 FETCH", () => {
    const result = compileSqlQuery(relationalQuery(), oracleDialect);

    expect(result.sql).toContain('FROM "dbo"."visit" "v" INNER JOIN "dbo"."patient" "p"');
    expect(result.sql.endsWith('ORDER BY "v"."id" DESC FETCH FIRST 51 ROWS ONLY')).toBe(true);
  });

  it("按 Oracle 方言显式转换日期时间参数", () => {
    const query = relationalQuery();
    query.filters.items = [
      { field: "v.visit_at", op: "eq", data_type: "datetime", value: "2026-09-01 08:30:00" },
    ];

    expect(compileSqlQuery(query, oracleDialect).sql).toContain(
      `"v"."visit_at" = TO_TIMESTAMP(:p0, 'YYYY-MM-DD HH24:MI:SS')`,
    );
  });

  it("编译固定存储过程调用", () => {
    const query = executableQuerySchema.parse({
      type: "parameterized_query",
      source_id: "clinical",
      timeout_ms: 12000,
      row_limit: 50,
      from: {
        object_id: "clinical.get_visits",
        native_schema_name: "dbo",
        native_object_name: "get_visits",
        alias: "g",
      },
      parameters: [
        { name: "department_id", data_type: "string", value: "GYN" },
        { name: "page_size", data_type: "integer", value: 50 },
      ],
    });
    if (query.type !== "parameterized_query") throw new Error("测试查询类型错误");

    expect(compileSqlQuery(query, sqlServerDialect)).toEqual({
      sql: "EXEC [dbo].[get_visits] @department_id = @p0, @page_size = @p1",
      parameters: [
        { value: "GYN", dataType: "string" },
        { value: 50, dataType: "integer" },
      ],
    });
  });

  // 在 Schema 解析后主动改坏值，单独检查编译器的参数类型保护。
  it("拒绝对象参数值", () => {
    const query = relationalQuery();
    query.filters.items = [
      { field: "v.department_id", op: "eq", data_type: "string", value: { id: "GYN" } },
    ];

    expect(() => compileSqlQuery(query, sqlServerDialect)).toThrow(
      "查询参数必须是数据库驱动支持的基础值",
    );
  });
});
