import { describe, expect, it } from "vitest";

import { mysqlDialect, oracleDialect, sqlServerDialect } from "../../src/connectors/dialects";
import {
  executableQuerySchema,
  type ExecutableRelationalQuery,
} from "../../src/connectors/executable-query";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";

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

describe("SQL 查询编译器", () => {
  // BDD 场景：API 已将条件和 Join 解析为最终 DSL；TDD 断言：SQL Server 仅拼接受控结构，所有值使用参数绑定。
  it("编译 SQL Server 关系查询和嵌套筛选", () => {
    const result = compileSqlQuery(relationalQuery(), sqlServerDialect);

    expect(result.sql).toBe(
      "SELECT TOP 50 [v].[id] AS [visit_id], COUNT([p].[id]) AS [patient_count] FROM [dbo].[visit] AS [v] INNER JOIN [dbo].[patient] AS [p] ON [v].[patient_id] = [p].[id] WHERE ([v].[department_id] = @p0 AND ([p].[status] IN (@p1, @p2) OR [p].[deleted_at] IS NULL)) GROUP BY [v].[id] ORDER BY [v].[id] DESC",
    );
    expect(result.parameters).toEqual([
      { value: "GYN", dataType: "string" },
      { value: "active", dataType: "string" },
      { value: "pending", dataType: "string" },
    ]);
  });

  // BDD 场景：MySQL 需要在查询尾部限制返回行数；TDD 断言：方言差异不改变最终 DSL 的参数顺序。
  it("按 MySQL 方言生成反引号标识符和 LIMIT", () => {
    const result = compileSqlQuery(relationalQuery(), mysqlDialect);

    expect(result.sql).toContain("SELECT `v`.`id` AS `visit_id`");
    expect(result.sql).toContain("`p`.`status` IN (?, ?)");
    expect(result.sql.endsWith("ORDER BY `v`.`id` DESC LIMIT 50")).toBe(true);
    expect(result.parameters).toEqual([
      { value: "GYN", dataType: "string" },
      { value: "active", dataType: "string" },
      { value: "pending", dataType: "string" },
    ]);
  });

  // BDD 场景：相同最终 DSL 发往 Oracle；TDD 断言：Oracle 关系别名不使用 AS，行数限制使用 FETCH。
  it("按 Oracle 方言生成关系别名和 FETCH", () => {
    const result = compileSqlQuery(relationalQuery(), oracleDialect);

    expect(result.sql).toContain('FROM "dbo"."visit" "v" INNER JOIN "dbo"."patient" "p"');
    expect(result.sql.endsWith('ORDER BY "v"."id" DESC FETCH FIRST 50 ROWS ONLY')).toBe(true);
  });

  // BDD 场景：API 传入标准日期时间文本；TDD 断言：Oracle SQL 使用固定格式转换，不依赖会话日期格式。
  it("按 Oracle 方言显式转换日期时间参数", () => {
    const query = relationalQuery();
    query.filters.items = [
      { field: "v.visit_at", op: "eq", data_type: "datetime", value: "2026-09-01 08:30:00" },
    ];

    expect(compileSqlQuery(query, oracleDialect).sql).toContain(
      `"v"."visit_at" = TO_TIMESTAMP(:p0, 'YYYY-MM-DD HH24:MI:SS')`,
    );
  });

  // BDD 场景：API 调用固定存储过程；TDD 断言：SQL Server 参数名和参数值分别进入受控调用位置与驱动绑定数组。
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

  // BDD 场景：上游错误地将对象传给最终 DSL；TDD 断言：编译器拒绝无法由数据库驱动绑定的参数值。
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
