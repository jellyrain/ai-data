import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import mssql from "mssql";
import type * as pg from "pg";
import { types as pgTypes } from "pg";

import { createDatabaseDriver } from "../../src/connectors/database-drivers";
import { DatabaseConnector } from "../../src/connectors/database-connector";
import { postgresqlDialect, sqlServerDialect } from "../../src/connectors/dialects";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const state = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  options: {} as Record<string, unknown>,
  mysqlEvents: [] as Array<{ connection: number; operation: string }>,
  mysqlConnectionCount: 0,
  failMysqlSetup: false,
  failMysqlQuery: false,
}));
vi.mock("mssql", async (original) => {
  const actual = await original<{ default: typeof mssql }>();
  return {
    default: {
      ...actual.default,
      ConnectionPool: class {
        constructor(options: Record<string, unknown>) {
          state.options = options;
        }
        async connect() {
          return this;
        }
        request() {
          const request = Object.assign(new EventEmitter(), {
            stream: false,
            input() {},
            cancel() {},
            async query() {
              if (request.stream) {
                const result = state.result.recordset as Array<Record<string, unknown>> & {
                  columns: Record<string, unknown>;
                };
                request.emit("recordset", result.columns);
                for (const row of result) request.emit("row", row);
              }
              return state.result;
            },
          });
          return request;
        }
        async close() {}
      },
    },
  };
});
vi.mock("mysql2/promise", () => ({
  default: {
    createPool(options: Record<string, unknown>) {
      state.options = options;
      return {
        async query() {
          return [state.result.rows ?? [], state.result.fields ?? []];
        },
        async getConnection() {
          const connection = ++state.mysqlConnectionCount;
          return {
            connection: { stream: new PassThrough() },
            async query(sql: string) {
              state.mysqlEvents.push({ connection, operation: sql });
              if (sql.startsWith("SET ") && state.failMysqlSetup)
                throw new Error("会话时区设置失败");
              if (!sql.startsWith("SET ") && state.failMysqlQuery) throw new Error("查询失败");
              return [state.result.rows ?? [], state.result.fields ?? []];
            },
            release() {
              state.mysqlEvents.push({ connection, operation: "release" });
            },
          };
        },
        async end() {},
      };
    },
  },
}));
vi.mock("pg", async (original) => {
  const actual = await original<typeof pg>();
  return {
    ...actual,
    Pool: class {
      constructor(options: Record<string, unknown>) {
        state.options = options;
      }
      async query() {
        return state.result;
      }
      async connect() {
        return {
          async query() {
            return state.result;
          },
          async end() {},
          release() {},
        };
      }
      async end() {}
    },
  };
});
vi.mock("oracledb", () => ({
  default: {
    OUT_FORMAT_OBJECT: 4002,
    DB_TYPE_VARCHAR: { name: "DB_TYPE_VARCHAR" },
    DB_TYPE_RAW: { name: "DB_TYPE_RAW" },
    async createPool() {
      return {
        async getConnection() {
          return {
            async execute() {
              return state.result;
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  },
}));

const config: DataSourceConfig = {
  sourceId: "clinical",
  connectorKind: "sqlserver",
  secretRef: "secret",
  targetDatabase: "reporting",
  oracleConnectType: "service_name",
  oracleConnectTarget: "reporting",
  timeoutMs: 1000,
  connectionPoolLimit: 1,
  concurrencyLimit: 1,
  rowLimit: 10,
  costLimit: 100,
};
const secret = { host: "test.invalid", port: 1234, user: "test", password: "test" };

describe("数据库驱动结果元数据", () => {
  beforeEach(() => {
    state.result = {};
    state.options = {};
    state.mysqlEvents = [];
    state.mysqlConnectionCount = 0;
    state.failMysqlSetup = false;
    state.failMysqlQuery = false;
  });
  it("SQL Server 多个表格结果集明确拒绝", async () => {
    state.result = { recordset: Object.assign([], { columns: {} }), recordsets: [[], []] };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "sqlserver" });
    await expect(driver.query("EXEC report", [])).rejects.toThrow("多个结果集");
  });
  it("MySQL CALL 展开单个表格及其空集元数据并忽略协议状态包", async () => {
    state.result = {
      rows: [[], { affectedRows: 0, warningStatus: 0 }],
      fields: [[{ name: "count", columnType: 3, flags: 1 }], undefined],
    };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "mysql" });
    await expect(driver.query("CALL report()", [])).resolves.toEqual({
      rows: [],
      columns: [{ name: "count", dataType: "int", nullable: false }],
    });
  });
  it("MySQL CALL 多个表格结果集明确拒绝", async () => {
    state.result = { rows: [[], [], { affectedRows: 0 }], fields: [[], [], undefined] };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "mysql" });
    await expect(driver.query("CALL report()", [])).rejects.toThrow("多个结果集");
  });
  it("SQL Server 从 recordset.columns 保留空结果的类型和可空标志", async () => {
    state.result = {
      recordset: Object.assign([], {
        columns: {
          total: { name: "total", type: mssql.Decimal, nullable: true },
          at: { name: "at", type: mssql.DateTime2, nullable: false },
        },
      }),
    };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "sqlserver" });
    expect((await driver.query("SELECT", [])).columns).toEqual([
      { name: "total", dataType: "Decimal", nullable: true },
      { name: "at", dataType: "DateTime2", nullable: false, dateMode: "utc_wall" },
    ]);
  });
  it("SQL Server Time 的 UTC 编码 Date 返回无时区纯时间", async () => {
    // tedious useUTC=true 将无时区 TIME 编码为 1970 年 UTC Date，日期部分不属于业务值。
    state.result = {
      recordset: Object.assign([{ at: new Date("1970-01-01T02:00:00.123Z") }], {
        columns: { at: { name: "at", type: mssql.Time, nullable: false } },
      }),
    };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "sqlserver" });
    const result = await new DatabaseConnector(config, driver, sqlServerDialect).execute({
      type: "parameterized_query",
      source_id: config.sourceId,
      from: { object_id: "report", native_object_name: "report", alias: "r" },
      parameters: [],
      fixed_output: [{ name: "at", data_type: "string", nullable: false }],
      row_limit: 1,
      timeout_ms: 1000,
    });
    expect(result.columns).toEqual([{ name: "at", data_type: "string" }]);
    expect(result.rows).toEqual([{ at: "02:00:00" }]);
  });
  it("MySQL 使用类型码与字符集区分 numeric、BIT、文本及二进制", async () => {
    state.result = {
      rows: [],
      fields: [
        { name: "amount", columnType: 246, flags: 1 },
        { name: "enabled", columnType: 16, columnLength: 1, flags: 0 },
        { name: "flags", columnType: 16, columnLength: 8, flags: 0 },
        { name: "note", columnType: 252, characterSet: 45, flags: 0 },
        { name: "data", columnType: 253, characterSet: 63, flags: 0 },
      ],
    };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "mysql" });
    expect((await driver.query("SELECT", [])).columns).toEqual([
      { name: "amount", dataType: "decimal", nullable: false },
      { name: "enabled", dataType: "boolean", nullable: true },
      { name: "flags", dataType: "varbinary", nullable: true },
      { name: "note", dataType: "string", nullable: true },
      { name: "data", dataType: "varbinary", nullable: true },
    ]);
    expect(state.options).toMatchObject({
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  });
  it("MySQL 每次借用连接都先设置东八区再执行并归还", async () => {
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "mysql" });
    await driver.query("SELECT first", []);
    await driver.query("SELECT second", []);
    expect(state.mysqlEvents).toEqual([
      { connection: 1, operation: "SET time_zone = '+08:00'" },
      { connection: 1, operation: "SELECT first" },
      { connection: 1, operation: "release" },
      { connection: 2, operation: "SET time_zone = '+08:00'" },
      { connection: 2, operation: "SELECT second" },
      { connection: 2, operation: "release" },
    ]);
  });
  it("MySQL 时区设置失败时归还连接并停止查询", async () => {
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "mysql" });
    state.failMysqlSetup = true;
    await expect(driver.query("SELECT records", [])).rejects.toThrow("会话时区设置失败");
    expect(state.mysqlEvents).toEqual([
      { connection: 1, operation: "SET time_zone = '+08:00'" },
      { connection: 1, operation: "release" },
    ]);
  });
  it("MySQL 查询失败后归还已准备的连接", async () => {
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "mysql" });
    state.failMysqlQuery = true;
    await expect(driver.query("SELECT records", [])).rejects.toThrow("查询失败");
    expect(state.mysqlEvents).toEqual([
      { connection: 1, operation: "SET time_zone = '+08:00'" },
      { connection: 1, operation: "SELECT records" },
      { connection: 1, operation: "release" },
    ]);
  });
  it("PostgreSQL 根据 OID 保留空聚合结果类型", async () => {
    state.result = {
      rows: [],
      fields: [
        { name: "count", dataTypeID: 20 },
        { name: "total", dataTypeID: 1700 },
        { name: "at", dataTypeID: 1114 },
        { name: "data", dataTypeID: 17 },
      ],
    };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "postgresql" });
    expect((await driver.query("SELECT", [])).columns).toEqual([
      { name: "count", dataType: "bigint" },
      { name: "total", dataType: "numeric" },
      { name: "at", dataType: "timestamp" },
      { name: "data", dataType: "bytea" },
    ]);
    const types = state.options.types as {
      getTypeParser(oid: number, format: "text"): (value: string) => unknown;
    };
    expect(types.getTypeParser(1114, "text")("2026-09-13 00:00:00")).toBe("2026-09-13 00:00:00");
  });
  it.each(["$1,234.50", "1.234,50 €", "-$1,234.50"])(
    "PostgreSQL money 保留源格式文本 %s",
    async (value) => {
      state.result = {
        rows: [{ amount: pgTypes.getTypeParser(790, "text")(value) }],
        fields: [{ name: "amount", dataTypeID: 790 }],
      };
      const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "postgresql" });
      const result = await new DatabaseConnector(
        { ...config, connectorKind: "postgresql" },
        driver,
        postgresqlDialect,
      ).execute({
        type: "parameterized_query",
        source_id: config.sourceId,
        from: { object_id: "report", native_object_name: "report", alias: "r" },
        parameters: [],
        fixed_output: [{ name: "amount", data_type: "string", nullable: false }],
        row_limit: 1,
        timeout_ms: 1000,
      });
      expect(result.columns).toEqual([{ name: "amount", data_type: "string" }]);
      expect(result.rows).toEqual([{ amount: value }]);
    },
  );
  it("Oracle 根据 NUMBER scale 和 DATE 时间语义保留元数据", async () => {
    state.result = {
      rows: [],
      metaData: [
        { name: "count", dbTypeName: "NUMBER", scale: 0, nullable: false },
        { name: "total", dbTypeName: "NUMBER", scale: 2, nullable: true },
        { name: "at", dbTypeName: "DATE", nullable: true },
        { name: "data", dbTypeName: "RAW", nullable: true },
      ],
    };
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "oracle" });
    expect((await driver.query("SELECT", [])).columns).toEqual([
      { name: "count", dataType: "integer", nullable: false },
      { name: "total", dataType: "NUMBER", nullable: true },
      { name: "at", dataType: "datetime", nullable: true, dateMode: "local_wall" },
      { name: "data", dataType: "RAW", nullable: true },
    ]);
  });
});
