import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { QueryPlanner } from "../../src/query-planning/query-planner";
import { compileSqlQuery } from "../../src/connectors/sql-query-compiler";
import { mysqlDialect } from "../../src/connectors/dialects";
import { preAggregationDataSql, preAggregationQuery } from "../support/pre-aggregation-fixtures";

/** 根据与编译器相同的统计场景构造已签名 API DSL，物理名称由本地目录重新提供。 */
function request() {
  const input = preAggregationQuery();
  return {
    access: {
      user_id: "user",
      organization_id: "org",
      analysis_run_id: "run",
      policy_version: 1,
      expires_at: "2026-09-13 12:00:00",
    },
    signature: "signed-test",
    query: {
      type: input.type,
      source_id: input.source_id,
      from: {
        object_id: input.from.object_id,
        alias: input.from.alias,
        filters: input.from.filters,
      },
      joins: input.joins.map(({ type, relation, on }) => ({
        type,
        object_id: relation.object_id,
        alias: relation.alias,
        filters: relation.filters,
        pre_aggregate: relation.pre_aggregate,
        on,
      })),
      select: input.select,
      group_by: input.group_by,
      order_by: input.order_by,
      filters: input.filters,
      limit: 1,
    },
  };
}

/** 本地白名单替身保留物理映射、验签顺序与源级行数限制。 */
function setup() {
  const verify = vi.fn(async () => {});
  const lookup = vi.fn(async (sourceId: string, objectId: string) => ({
    sourceId,
    objectId,
    objectKind: "table" as const,
    nativeSchemaName: "dbo",
    nativeObjectName: `physical_${objectId}`,
    isQueryable: true,
    isDiscoverable: true,
    queryCapabilities: {},
  }));
  const planner = new QueryPlanner(
    {
      findEnabledBySourceId: async () => ({
        sourceId: "clinical",
        connectorKind: "sqlserver",
        secretRef: "test",
        timeoutMs: 1000,
        connectionPoolLimit: 1,
        concurrencyLimit: 1,
        rowLimit: 100,
        costLimit: 1,
      }),
    },
    { findQueryableBySourceIdAndObjectId: lookup },
    { verify },
  );
  return { planner, verify, lookup };
}

describe("分层聚合的本地规划", () => {
  it("验签后映射物理对象，完整保留过滤和内层聚合", async () => {
    const { planner, verify, lookup } = setup();
    const input = request();
    const plan = await planner.plan(input);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(lookup.mock.invocationCallOrder[0]);
    expect(plan.query).toMatchObject({
      row_limit: 1,
      from: {
        native_schema_name: "dbo",
        native_object_name: "physical_visit",
        filters: input.query.from.filters,
      },
      joins: [
        {
          relation: {
            native_object_name: "physical_fee",
            pre_aggregate: input.query.joins[0].pre_aggregate,
          },
        },
        {
          relation: {
            native_object_name: "physical_prescription",
            pre_aggregate: input.query.joins[1].pre_aggregate,
          },
        },
      ],
    });
  });

  it("批准关系标识用于 API 授权，规划为相同的本地 JOIN 语义", async () => {
    const { planner } = setup();
    const input = request();
    const plan = await planner.plan({
      ...input,
      query: {
        ...input.query,
        joins: input.query.joins.map((join) => ({ ...join, relation_id: "by_visit" })),
      },
    });
    expect(JSON.stringify(plan.query)).not.toContain("relation_id");
  });

  it("支持按聚合输出别名排序", async () => {
    const { planner } = setup();
    const input = request();
    expect(
      (
        await planner.plan({
          ...input,
          query: { ...input.query, order_by: [{ field: "fees", direction: "desc" }] },
        })
      ).query,
    ).toMatchObject({ order_by: [{ field: "fees", direction: "desc" }] });
  });

  it("已签名 DSL 经规划与物理映射后执行真实 SQL 总计", async () => {
    const { planner } = setup();
    const plan = await planner.plan(request());
    const compiled = compileSqlQuery(plan.query, mysqlDialect);
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`${preAggregationDataSql}
        ATTACH DATABASE ':memory:' AS dbo;
        CREATE TABLE dbo.physical_visit AS SELECT * FROM visit;
        CREATE TABLE dbo.physical_fee AS SELECT * FROM fee;
        CREATE TABLE dbo.physical_prescription AS SELECT * FROM prescription;
      `);
      expect(
        database
          .prepare(compiled.sql)
          .all(
            ...compiled.parameters.map(({ value }) =>
              typeof value === "boolean" ? Number(value) : value,
            ),
          ),
      ).toEqual([{ visits: 3, fees: 240, prescriptions: 5 }]);
    } finally {
      database.close();
    }
  });

  it("主对象预聚合的复合键投影在物理映射后完整保留", async () => {
    const { planner } = setup();
    const input = request();
    const pre_aggregate = {
      group_by: ["v.id", "v.org"],
      select: [
        { field: "v.id", as: "key" },
        { field: "v.org", as: "organization" },
      ],
    };
    const plan = await planner.plan({
      ...input,
      query: {
        ...input.query,
        from: { ...input.query.from, pre_aggregate },
        joins: [],
        select: [{ field: "v.key", aggregation: "count", as: "combinations" }],
      },
    });
    expect(plan.query.from).toMatchObject({
      native_object_name: "physical_visit",
      pre_aggregate,
      filters: input.query.from.filters,
    });
  });

  it.each(["select", "filter", "group", "order", "join"])(
    "拒绝 %s 层越过对象预聚合输出边界",
    async (target) => {
      const { planner } = setup();
      const input = request();
      const change =
        target === "select"
          ? { select: [{ field: "f.amount", aggregation: "sum", as: "total" }] }
          : target === "filter"
            ? {
                filters: {
                  logic: "and",
                  items: [{ field: "f.amount", op: "eq", data_type: "integer", value: 1 }],
                },
              }
            : target === "group"
              ? { group_by: ["f.amount"] }
              : target === "order"
                ? { order_by: [{ field: "f.amount", direction: "asc" }] }
                : {
                    joins: [
                      {
                        ...input.query.joins[0],
                        on: [{ left: "v.id", op: "eq", right: "f.visit_id" }],
                      },
                      input.query.joins[1],
                    ],
                  };
      await expect(
        planner.plan({ ...input, query: { ...input.query, ...change } }),
      ).rejects.toThrow();
    },
  );
});
