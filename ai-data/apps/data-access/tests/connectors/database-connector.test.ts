import { describe, expect, it } from "vitest";

import { DatabaseConnector, type DatabaseDriver } from "../../src/connectors/database-connector";
import { sqlServerDialect } from "../../src/connectors/dialects";
import type { DataSourceConfig } from "../../src/metadata/metadata-records";

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

describe("数据库连接器", () => {
  // BDD 场景：驱动返回的行数多于 DAS 最终限制；TDD 断言：连接器执行编译 SQL 后仅返回允许行数，并明确截断状态。
  it("执行已编译查询并标准化受限结果", async () => {
    const calls: Array<{ sql: string; parameters: unknown[] }> = [];
    const driver: DatabaseDriver = {
      async query(sql, parameters) {
        calls.push({ sql, parameters });
        return {
          rows: [{ visit_id: 1 }, { visit_id: 2 }],
          columns: [{ name: "visit_id", dataType: "int" }],
        };
      },
      async close() {},
    };
    const connector = new DatabaseConnector(config, driver, sqlServerDialect);

    const result = await connector.execute(query());

    expect(calls).toEqual([
      {
        sql: "SELECT TOP 1 [v].[id] AS [visit_id] FROM [dbo].[visit] AS [v]",
        parameters: [],
      },
    ]);
    expect(result).toEqual({
      columns: [{ name: "visit_id", data_type: "integer" }],
      rows: [{ visit_id: 1 }],
      row_count: 1,
      truncated: true,
    });
  });

  // BDD 场景：业务表返回二进制列；TDD 断言：连接器向 JSON 结果输出 Base64 文本并保留 buffer 类型。
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

    await expect(connector.execute(query())).resolves.toMatchObject({
      columns: [{ name: "attachment", data_type: "buffer" }],
      rows: [{ attachment: "YWJj" }],
    });
  });

  // BDD 场景：路由误将其他数据源的最终 DSL 交给本连接器；TDD 断言：驱动不执行该查询。
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
