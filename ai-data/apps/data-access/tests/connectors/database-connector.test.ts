import { describe, expect, it } from "vitest";

import { DatabaseConnector, type DatabaseDriver } from "../../src/connectors/database-connector";
import {
  sqlServerDialect,
  mysqlDialect,
  postgresqlDialect,
  oracleDialect,
  type DatabaseDialect,
} from "../../src/connectors/dialects";
import type { ExecutableParameterizedQuery } from "../../src/connectors/executable-query";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const config: DataSourceConfig = {
  sourceId: "clinical",
  connectorKind: "sqlserver",
  secretRef: "clinical-secret",
  targetDatabase: "clinical_reporting",
  timeoutMs: 12000,
  connectionPoolLimit: 10,
  concurrencyLimit: 20,
  rowLimit: 100,
  costLimit: 1000,
};

/** 返回上限为 1 行的最小查询，供出口裁剪和数据源匹配场景复用。 */
function query() {
  return {
    type: "relational_query" as const,
    source_id: "clinical",
    timeout_ms: 12000,
    row_limit: 1,
    from: {
      object_id: "clinical.visit",
      native_schema_name: "dbo",
      native_object_name: "visit",
      alias: "v",
    },
    joins: [],
    filters: { logic: "and" as const, items: [] },
    select: [{ field: "v.id", as: "visit_id" }],
    group_by: [],
    order_by: [],
  };
}

/** 从编译结果读取真实 SQL 上限，替身据此裁剪固定源数据；不支持的 SQL 立即使场景失败。 */
function sqlRowLimit(sql: string, dialect: DatabaseDialect): number {
  const match =
    dialect.kind === "sqlserver"
      ? sql.match(/\bTOP (\d+)\b/)
      : dialect.kind === "oracle"
        ? sql.match(/FETCH FIRST (\d+) ROWS ONLY/)
        : sql.match(/\bLIMIT (\d+)\b/);
  if (!match) throw new Error("测试 SQL 未包含方言行数限制");
  return Number(match[1]);
}
describe("数据库连接器", () => {
  it.each([
    { dialect: sqlServerDialect, nativeType: "timestamp", expected: "buffer" },
    { dialect: sqlServerDialect, nativeType: "rowversion", expected: "buffer" },
    { dialect: oracleDialect, nativeType: "DATE", expected: "datetime" },
    { dialect: postgresqlDialect, nativeType: "bit", expected: "string" },
    { dialect: postgresqlDialect, nativeType: "money", expected: "string" },
    { dialect: mysqlDialect, nativeType: "bit(1)", expected: "boolean" },
    { dialect: mysqlDialect, nativeType: "bit(8)", expected: "buffer" },
  ])(
    "$dialect.kind 按数据库语义解释目录 $nativeType",
    async ({ dialect, nativeType, expected }) => {
      if (dialect.kind === "mysql") expect(dialect.catalogSql()).toContain("c.COLUMN_TYPE");
      const driver: DatabaseDriver = {
        async query() {
          return {
            rows: [
              {
                object_name: "records",
                column_name: "value",
                data_type: nativeType,
                is_nullable: true,
              },
            ],
          };
        },
        async close() {},
      };
      const result = await new DatabaseConnector(
        { ...config, connectorKind: dialect.kind },
        driver,
        dialect,
      ).discoverCatalog();
      expect(result[0]?.columns[0]?.data_type).toBe(expected);
    },
  );
  it("驱动行包含列定义之外的字段时拒绝不一致结果", async () => {
    const driver: DatabaseDriver = {
      async query() {
        return { rows: [{ id: 1, extra: 2 }], columns: [{ name: "id", dataType: "integer" }] };
      },
      async close() {},
    };
    await expect(
      new DatabaseConnector(config, driver, sqlServerDialect).execute(query()),
    ).rejects.toThrow("结果行字段必须与列定义一致");
  });
  it("按列元数据转换驱动值并保持 JSON 格式稳定", async () => {
    const driver: DatabaseDriver = {
      async query() {
        return {
          columns: [
            { name: "id", dataType: "bigint" },
            { name: "amount", dataType: "numeric" },
            { name: "enabled", dataType: "bit" },
            { name: "day", dataType: "date" },
            { name: "at", dataType: "datetime2" },
            { name: "data", dataType: "varbinary" },
            { name: "optional", dataType: "int" },
          ],
          rows: [
            {
              id: 12n,
              amount: "12.50",
              enabled: Buffer.from([1]),
              day: "2026-09-13",
              at: new Date("2026-09-12T18:00:00Z"),
              data: Buffer.alloc(0),
              optional: null,
            },
          ],
        };
      },
      async close() {},
    };
    const result = await new DatabaseConnector(config, driver, sqlServerDialect).execute(query());
    expect(JSON.parse(JSON.stringify(result.rows))).toEqual([
      {
        id: 12,
        amount: 12.5,
        enabled: true,
        day: "2026-09-13",
        at: "2026-09-13 02:00:00",
        data: "",
        optional: null,
      },
    ]);
  });

  it("空结果仍按驱动元数据返回类型", async () => {
    const driver: DatabaseDriver = {
      async query() {
        return { rows: [], columns: [{ name: "total", dataType: "numeric" }] };
      },
      async close() {},
    };
    await expect(
      new DatabaseConnector(config, driver, sqlServerDialect).execute(query()),
    ).resolves.toMatchObject({
      columns: [{ name: "total", data_type: "decimal" }],
      rows: [],
      row_count: 0,
    });
  });

  it.each(["9007199254740993", "12x", "", 1.5])(
    "integer 值 %s 无法安全转换时拒绝",
    async (value) => {
      const driver: DatabaseDriver = {
        async query() {
          return { rows: [{ id: value }], columns: [{ name: "id", dataType: "bigint" }] };
        },
        async close() {},
      };
      await expect(
        new DatabaseConnector(config, driver, sqlServerDialect).execute(query()),
      ).rejects.toThrow("结果字段 id");
    },
  );
  describe.each([sqlServerDialect, mysqlDialect, postgresqlDialect, oracleDialect])(
    "$kind 的结果截断",
    (dialect) => {
      it.each([0, 1, 2, 3])("上限为 2、实际结果为 %i 行时正确返回截断状态", async (count) => {
        const sourceRows = Array.from({ length: count }, (_, index) => ({ visit_id: index + 1 }));
        const driver: DatabaseDriver = {
          async query(sql) {
            return { rows: sourceRows.slice(0, sqlRowLimit(sql, dialect)) };
          },
          async close() {},
        };
        const connector = new DatabaseConnector(
          { ...config, connectorKind: dialect.kind },
          driver,
          dialect,
        );
        const input = { ...query(), row_limit: 2 };
        const result = await connector.execute(input);
        expect(result.rows).toEqual(sourceRows.slice(0, 2));
        expect(result.row_count).toBe(Math.min(count, 2));
        expect(result.truncated).toBe(count > 2);
        expect(input.row_limit).toBe(2);
      });

      it("最多读取一行额外结果作为截断依据", async () => {
        let readLimit = 0;
        const driver: DatabaseDriver = {
          async query(sql) {
            readLimit = sqlRowLimit(sql, dialect);
            return {
              rows: Array.from({ length: 5001 }, (_, index) => ({ visit_id: index + 1 })).slice(
                0,
                readLimit,
              ),
            };
          },
          async close() {},
        };
        const result = await new DatabaseConnector(
          { ...config, connectorKind: dialect.kind, rowLimit: 5000 },
          driver,
          dialect,
        ).execute({ ...query(), row_limit: 5000 });
        expect(readLimit).toBe(5001);
        expect(result.rows).toHaveLength(5000);
        expect(result.row_count).toBe(5000);
        expect(result.truncated).toBe(true);
      });
    },
  );

  it.each([0, 1, 2, 3])("固定存储过程返回 %i 行时按完整结果判断截断", async (count) => {
    const sourceRows = Array.from({ length: count }, (_, index) => ({ visit_id: index + 1 }));
    const calls: Array<{ sql: string; parameters: unknown[] }> = [];
    const driver: DatabaseDriver = {
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        return {
          rows: sourceRows,
          columns: [{ name: "visit_id", dataType: "int", nullable: false }],
        };
      },
      async close() {},
    };
    const input: ExecutableParameterizedQuery = {
      type: "parameterized_query",
      source_id: "clinical",
      timeout_ms: 12000,
      row_limit: 2,
      from: { ...query().from, native_object_name: "get_visits" },
      parameters: [{ name: "department", data_type: "string", value: "GYN" }],
      fixed_output: [{ name: "visit_id", data_type: "integer", nullable: false }],
    };
    const result = await new DatabaseConnector(config, driver, sqlServerDialect).execute(input);
    expect(calls).toEqual([
      {
        sql: "EXEC [dbo].[get_visits] @department = @p0",
        parameters: [{ value: "GYN", dataType: "string" }],
      },
    ]);
    expect(result.rows).toEqual(sourceRows.slice(0, 2));
    expect(result.truncated).toBe(count > 2);
  });

  it("将二进制结果转换为 Base64", async () => {
    const driver: DatabaseDriver = {
      async query() {
        return {
          rows: [{ attachment: Buffer.from("abc") }],
          columns: [{ name: "attachment", dataType: "varbinary" }],
        };
      },
      async close() {},
    };
    const connector = new DatabaseConnector(config, driver, sqlServerDialect);

    await expect(
      connector.execute({ ...query(), select: [{ field: "v.attachment", as: "attachment" }] }),
    ).resolves.toMatchObject({
      columns: [{ name: "attachment", data_type: "buffer" }],
      rows: [{ attachment: "YWJj" }],
    });
  });

  it("拒绝不属于当前数据源的查询", async () => {
    const driver: DatabaseDriver = {
      async query() {
        throw new Error("不应调用驱动");
      },
      async close() {},
    };
    const connector = new DatabaseConnector(config, driver, sqlServerDialect);
    const wrongSourceQuery = { ...query(), source_id: "other" };

    await expect(connector.execute(wrongSourceQuery)).rejects.toThrow(
      "查询数据源与连接器不匹配: other",
    );
  });
});
