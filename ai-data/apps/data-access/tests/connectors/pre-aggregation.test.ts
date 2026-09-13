import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { executableRelationalQuerySchema } from "../../src/connectors/executable-query";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";
import { DatabaseConnector } from "../../src/connectors/database-connector";
import {
  mysqlDialect,
  oracleDialect,
  postgresqlDialect,
  sqlServerDialect,
} from "../../src/connectors/dialects";
import { preAggregationDataSql, preAggregationQuery } from "../support/pre-aggregation-fixtures";

/** 执行真实内存 SQL，隔离查询语义验收与外部数据库依赖。 */
function execute(input: unknown, dataSql = preAggregationDataSql) {
  const query = executableRelationalQuerySchema.parse(input);
  const compiled = compileSqlQuery(query, mysqlDialect);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(dataSql);
    return database.prepare(compiled.sql).all(
      ...compiled.parameters.map(({ value }) => {
        if (typeof value === "boolean") return value ? 1 : 0;
        return value;
      }),
    );
  } finally {
    database.close();
  }
}

describe("对象预聚合 SQL 与统计语义", () => {
  it("多费用多处方先独立汇总，最终统计按就诊粒度相加", () => {
    expect(execute(preAggregationQuery())).toEqual([{ visits: 3, fees: 240, prescriptions: 5 }]);
  });

  it("LEFT JOIN 保留无明细的主记录且重复金额逐笔计入", () => {
    expect(
      execute({
        ...preAggregationQuery(),
        select: [
          { field: "v.id", as: "id" },
          { field: "f.fee_sum", as: "fees" },
          { field: "r.prescription_count", as: "prescriptions" },
        ],
        order_by: [{ field: "v.id", direction: "asc" }],
      }),
    ).toEqual([
      { id: 1, fees: 200, prescriptions: 3 },
      { id: 2, fees: 40, prescriptions: 2 },
      { id: 3, fees: null, prescriptions: null },
    ]);
  });

  it("对象权限在预聚合前生效，未授权同一就诊明细不参与统计", () => {
    expect(
      execute(
        preAggregationQuery(),
        `${preAggregationDataSql} INSERT INTO fee VALUES(99,1,500,'B'); INSERT INTO prescription VALUES(99,1,'B');`,
      ),
    ).toEqual([{ visits: 3, fees: 240, prescriptions: 5 }]);
  });

  it("外层只返回一行时内层全部分组仍参与总计", () => {
    const input = { ...preAggregationQuery(), row_limit: 1 };
    expect(execute(input)).toEqual([{ visits: 3, fees: 240, prescriptions: 5 }]);
    const compiled = compileSqlQuery(executableRelationalQuerySchema.parse(input), mysqlDialect);
    expect(compiled.sql.match(/LIMIT/g)).toHaveLength(1);
    expect(compiled.sql.endsWith("LIMIT 2")).toBe(true);
  });

  it("原始输入为空时最终 COUNT 为零而 SUM 保留 SQL 空值语义", () => {
    expect(execute(preAggregationQuery(), `${preAggregationDataSql} DELETE FROM visit;`)).toEqual([
      { visits: 0, fees: null, prescriptions: null },
    ]);
  });

  it("空 OR 对象范围先形成空明细再保持 LEFT JOIN 主记录", () => {
    const input = preAggregationQuery();
    expect(
      execute({
        ...input,
        joins: [
          {
            ...input.joins[0],
            relation: { ...input.joins[0].relation, filters: { logic: "or", items: [] } },
          },
          input.joins[1],
        ],
      }),
    ).toEqual([{ visits: 3, fees: null, prescriptions: 5 }]);
  });

  it("复合键先通过 GROUP BY 去重，再统计组合数量", () => {
    const input = {
      ...preAggregationQuery(),
      from: {
        object_id: "fee",
        native_object_name: "fee",
        alias: "f",
        pre_aggregate: {
          group_by: ["f.visit_id", "f.org"],
          select: [
            { field: "f.visit_id", as: "visit_key" },
            { field: "f.org", as: "organization" },
          ],
        },
      },
      joins: [],
      select: [{ field: "f.visit_key", aggregation: "count", as: "combinations" }],
    };
    expect(execute(input)).toEqual([{ combinations: 3 }]);
  });

  it("按外层聚合结果别名排序", () => {
    const input = {
      ...preAggregationQuery(),
      select: [
        { field: "v.id", as: "id" },
        { field: "f.fee_sum", aggregation: "sum", as: "total" },
      ],
      group_by: ["v.id"],
      order_by: [{ field: "total", direction: "desc" }],
    };
    expect(execute(input)).toEqual([
      { id: 1, total: 200 },
      { id: 2, total: 40 },
      { id: 3, total: null },
    ]);
  });

  it("内层保留 count_distinct、avg、min 与 max 的明确统计定义", () => {
    const input = preAggregationQuery();
    expect(
      execute({
        ...input,
        from: {
          ...input.joins[0].relation,
          pre_aggregate: {
            group_by: ["f.visit_id"],
            select: [
              { field: "f.visit_id", as: "visit_key" },
              { field: "f.amount", aggregation: "count_distinct", as: "distinct_amounts" },
              { field: "f.amount", aggregation: "avg", as: "mean" },
              { field: "f.amount", aggregation: "min", as: "minimum" },
              { field: "f.amount", aggregation: "max", as: "maximum" },
            ],
          },
        },
        joins: [],
        select: [
          { field: "f.visit_key", as: "id" },
          { field: "f.distinct_amounts", as: "distinct_amounts" },
          { field: "f.mean", as: "mean" },
          { field: "f.minimum", as: "minimum" },
          { field: "f.maximum", as: "maximum" },
        ],
        order_by: [{ field: "id", direction: "asc" }],
      }),
    ).toEqual([
      { id: 1, distinct_amounts: 1, mean: 100, minimum: 100, maximum: 100 },
      { id: 2, distinct_amounts: 1, mean: 40, minimum: 40, maximum: 40 },
    ]);
  });

  it("连接器只截断最终分组结果并保留准确截断标记", async () => {
    const query = executableRelationalQuerySchema.parse({
      ...preAggregationQuery(),
      row_limit: 1,
      select: [
        { field: "v.id", as: "id" },
        { field: "f.fee_sum", aggregation: "sum", as: "fees" },
      ],
      group_by: ["v.id"],
      order_by: [{ field: "fees", direction: "desc" }],
    });
    const database = new DatabaseSync(":memory:");
    database.exec(preAggregationDataSql);
    const connector = new DatabaseConnector(
      {
        sourceId: "clinical",
        connectorKind: "mysql",
        secretRef: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 1,
        costLimit: 1,
      },
      {
        query: async (sql, parameters) => {
          const statement = database.prepare(sql);
          return {
            rows: statement.all(
              ...parameters.map(({ value }) =>
                typeof value === "boolean" ? Number(value) : value,
              ),
            ),
            columns: statement
              .columns()
              .map((column) => ({ name: column.name, dataType: "integer" })),
          };
        },
        close: async () => database.close(),
      },
      mysqlDialect,
    );
    try {
      expect(await connector.execute(query)).toEqual({
        columns: [
          { name: "id", data_type: "integer" },
          { name: "fees", data_type: "integer" },
        ],
        rows: [{ id: 1, fees: 200 }],
        row_count: 1,
        truncated: true,
      });
    } finally {
      await connector.close();
    }
  });

  it.each([mysqlDialect, postgresqlDialect, sqlServerDialect, oracleDialect])(
    "$kind 编译内层GROUP BY且只在最外层限制行数",
    (dialect) => {
      const compiled = compileSqlQuery(
        executableRelationalQuerySchema.parse({ ...preAggregationQuery(), row_limit: 1 }),
        dialect,
      );
      expect(compiled.sql.match(/GROUP BY/g)).toHaveLength(2);
      expect(compiled.sql.match(/SELECT/g)).toHaveLength(4);
      expect(compiled.sql.match(/TOP |LIMIT |FETCH FIRST /g)).toHaveLength(1);
      const name = (value: string) => dialect.quoteIdentifier(value);
      expect(compiled.sql).toContain(`SUM(${name("f")}.${name("amount")}) AS ${name("fee_sum")}`);
      expect(compiled.sql).toContain(`GROUP BY ${name("f")}.${name("visit_id")}`);
      expect(compiled.parameters.map(({ value }) => value)).toEqual(["A", "A", "A"]);
    },
  );

  it("内层与外层过滤按 SQL 出现顺序绑定参数", () => {
    const input = {
      ...preAggregationQuery(),
      filters: {
        logic: "and",
        items: [{ field: "v.id", op: "between", data_type: "integer", value: [1, 2] }],
      },
    };
    const compiled = compileSqlQuery(
      executableRelationalQuerySchema.parse(input),
      postgresqlDialect,
    );
    expect(compiled.parameters.map(({ value }) => value)).toEqual(["A", "A", "A", 1, 2]);
    expect(compiled.sql).toContain('"v"."org" = $1');
    expect(compiled.sql).toContain('"f"."org" = $2');
    expect(compiled.sql).toContain('"r"."org" = $3');
    expect(compiled.sql).toContain('"v"."id" BETWEEN $4 AND $5');
  });
});

describe("可执行预聚合的严格层级边界", () => {
  it.each([
    { group_by: [], select: [{ field: "f.amount", aggregation: "sum", as: "total" }] },
    { group_by: ["f.visit_id"], select: [{ field: "f.amount", aggregation: "sum", as: "total" }] },
    {
      group_by: ["f.visit_id"],
      select: [
        { field: "f.visit_id", as: "key" },
        { field: "f.amount", as: "amount" },
      ],
    },
    {
      group_by: ["f.visit_id"],
      select: [
        { field: "f.visit_id", as: "key" },
        { field: "f.amount", aggregation: "sum", as: "key" },
      ],
    },
    { group_by: ["v.id"], select: [{ field: "v.id", as: "visit_key" }] },
    { group_by: ["f.visit_id"], select: [{ field: "f.visit_id", as: "visit_key" }], limit: 1 },
  ])("拒绝不完整或跨层的对象聚合 %j", (pre_aggregate) => {
    const input = preAggregationQuery();
    expect(
      executableRelationalQuerySchema.safeParse({
        ...input,
        joins: [
          { ...input.joins[0], relation: { ...input.joins[0].relation, pre_aggregate } },
          input.joins[1],
        ],
      }).success,
    ).toBe(false);
  });

  it.each(["select", "filters", "group_by", "order_by", "join"])(
    "外层 %s 拒绝引用已被派生输出隐藏的原始字段",
    (target) => {
      const input = preAggregationQuery();
      const changed =
        target === "select"
          ? { select: [{ field: "f.amount", aggregation: "sum", as: "amount" }] }
          : target === "filters"
            ? {
                filters: {
                  logic: "and",
                  items: [{ field: "f.amount", op: "eq", data_type: "integer", value: 1 }],
                },
              }
            : target === "group_by"
              ? { group_by: ["f.amount"] }
              : target === "order_by"
                ? { order_by: [{ field: "f.amount", direction: "asc" }] }
                : {
                    joins: [
                      { ...input.joins[0], on: [{ left: "v.id", op: "eq", right: "f.visit_id" }] },
                      input.joins[1],
                    ],
                  };
      expect(executableRelationalQuerySchema.safeParse({ ...input, ...changed }).success).toBe(
        false,
      );
    },
  );

  it("聚合查询拒绝选择与排序未分组原始列", () => {
    const input = preAggregationQuery();
    expect(
      executableRelationalQuerySchema.safeParse({
        ...input,
        select: [...input.select, { field: "v.id", as: "id" }],
      }).success,
    ).toBe(false);
    expect(
      executableRelationalQuerySchema.safeParse({
        ...input,
        order_by: [{ field: "v.id", direction: "asc" }],
      }).success,
    ).toBe(false);
  });

  it("对象过滤不能引用其他对象，排序结果别名必须真实存在", () => {
    const input = preAggregationQuery();
    expect(
      executableRelationalQuerySchema.safeParse({
        ...input,
        from: {
          ...input.from,
          filters: {
            logic: "and",
            items: [{ field: "f.amount", op: "eq", data_type: "integer", value: 1 }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      executableRelationalQuerySchema.safeParse({
        ...input,
        order_by: [{ field: "missing", direction: "asc" }],
      }).success,
    ).toBe(false);
  });
});
