import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { DatabaseConnector } from "../../src/connectors/database-connector";
import { sqlServerDialect } from "../../src/connectors/dialects";
import { executableRelationalQuerySchema } from "../../src/connectors/executable-query";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";

/** 内层平均整数值后，在外层按 decimal 筛选并再次平均派生输出。 */
function averageQuery() {
  return executableRelationalQuerySchema.parse({
    type: "relational_query",
    source_id: "clinical",
    timeout_ms: 1000,
    row_limit: 100,
    from: {
      object_id: "fee",
      native_object_name: "fee",
      alias: "f",
      pre_aggregate: {
        group_by: ["f.visit_id"],
        select: [
          { field: "f.visit_id", as: "visit_key" },
          { field: "f.amount", aggregation: "avg", as: "mean" },
        ],
      },
    },
    joins: [],
    filters: {
      logic: "and",
      items: [{ field: "f.mean", op: "eq", data_type: "decimal", value: 1.5 }],
    },
    select: [{ field: "f.mean", aggregation: "avg", as: "overall_mean" }],
    group_by: [],
    order_by: [],
  });
}

describe("SQL Server 平均值小数语义", () => {
  it("内外层 AVG 都先提升为双精度浮点以保持小数", () => {
    const compiled = compileSqlQuery(averageQuery(), sqlServerDialect);
    expect(compiled.sql).toContain("AVG(CAST([f].[amount] AS FLOAT(53))) AS [mean]");
    expect(compiled.sql).toContain("AVG(CAST([f].[mean] AS FLOAT(53))) AS [overall_mean]");
    expect(compiled.parameters).toEqual([{ value: 1.5, dataType: "decimal" }]);
  });

  it("同一 CAST 表达式可执行得到 1.5 并按真实浮点元数据返回 decimal", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      "CREATE TABLE fee(visit_id INTEGER, amount INTEGER); INSERT INTO fee VALUES(1,1),(1,2);",
    );
    // 仅将 SQL Server TOP 语法替换为 SQLite LIMIT；AVG/CAST、字段引用及命名参数保持编译输出。
    const dialect = {
      ...sqlServerDialect,
      selectLimitSql: () => "",
      limitSql: (limit: number) => `LIMIT ${limit}`,
    };
    const connector = new DatabaseConnector(
      {
        sourceId: "clinical",
        connectorKind: "sqlserver",
        secretRef: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 100,
        costLimit: 1,
      },
      {
        query: async (sql, parameters) => {
          const statement = database.prepare(sql);
          const values = Object.fromEntries(
            parameters.map(({ value }, index) => [
              `p${index}`,
              typeof value === "boolean" ? Number(value) : value,
            ]),
          );
          return {
            rows: statement.all(values),
            columns: [{ name: "overall_mean", dataType: "float" }],
          };
        },
        close: async () => database.close(),
      },
      dialect,
    );
    try {
      expect(await connector.execute(averageQuery())).toEqual({
        columns: [{ name: "overall_mean", data_type: "decimal" }],
        rows: [{ overall_mean: 1.5 }],
        row_count: 1,
        truncated: false,
      });
    } finally {
      await connector.close();
    }
  });
});
