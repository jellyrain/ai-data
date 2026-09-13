import mssql from "mssql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataConnectionConfig, MetadataParameter } from "../../src/metadata-types";
import { SqlServerMetadataDatabase } from "../../src/sqlserver/sqlserver-database";

/** 只替换 mssql 连接池边界，参数绑定、失败处理与结果转换使用真实元数据库实现。 */
const driver = vi.hoisted(() => {
  const request = { input: vi.fn(), query: vi.fn(), batch: vi.fn() };
  const pool = { connect: vi.fn(), close: vi.fn(), request: vi.fn(() => request) };
  const ConnectionPool = vi.fn(function () {
    return pool;
  });
  return { request, pool, ConnectionPool };
});
vi.mock("mssql", () => ({
  default: {
    ConnectionPool: driver.ConnectionPool,
    NVarChar: "nvarchar",
    Int: "int",
    BigInt: "bigint",
    Bit: "bit",
    VarBinary: "varbinary",
    DateTime2: "datetime2",
  },
}));

const config: MetadataConnectionConfig = {
  server: "test-host",
  port: 1433,
  database: "test-db",
  user: "test",
  password: "test",
  options: {
    encrypt: true,
    trust_server_certificate: false,
    connection_timeout_ms: 5000,
    request_timeout_ms: 10000,
    pool: { max: 5, min: 0, idle_timeout_ms: 30000 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  driver.pool.connect.mockReset().mockResolvedValue(driver.pool);
  driver.pool.close.mockReset().mockResolvedValue(undefined);
  driver.request.query.mockReset().mockResolvedValue({ recordset: [], rowsAffected: [] });
});

describe("SQL Server 元数据库", () => {
  it("将连接配置和资源限制传给独立连接池", async () => {
    const database = await SqlServerMetadataDatabase.connect(config);
    expect(driver.ConnectionPool).toHaveBeenCalledWith({
      server: "test-host",
      port: 1433,
      database: "test-db",
      user: "test",
      password: "test",
      connectionTimeout: 5000,
      requestTimeout: 10000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      options: { encrypt: true, trustServerCertificate: false },
    });
    await database.close();
    expect(driver.pool.close).toHaveBeenCalledTimes(1);
  });

  it("连接失败后释放池并传递原始错误", async () => {
    const failure = new Error("连接失败");
    driver.pool.connect.mockRejectedValue(failure);
    await expect(SqlServerMetadataDatabase.connect(config)).rejects.toBe(failure);
    expect(driver.pool.close).toHaveBeenCalledTimes(1);
  });

  it("连接和清理都失败时保留两个原因", async () => {
    const connectionFailure = new Error("连接失败");
    const closeFailure = new Error("清理失败");
    driver.pool.connect.mockRejectedValue(connectionFailure);
    driver.pool.close.mockRejectedValue(closeFailure);
    await expect(SqlServerMetadataDatabase.connect(config)).rejects.toMatchObject({
      cause: connectionFailure,
      errors: [connectionFailure, closeFailure],
    });
  });

  it.each([
    [{ name: "text", type: "string", value: "a'; DROP TABLE example;--" }, mssql.NVarChar],
    [{ name: "number", type: "integer", value: 12 }, mssql.Int],
    [{ name: "large", type: "bigint", value: 2147483648 }, mssql.BigInt],
    [{ name: "flag", type: "boolean", value: true }, mssql.Bit],
    [{ name: "bytes", type: "binary", value: Buffer.from("abc") }, mssql.VarBinary],
    [{ name: "time", type: "date", value: new Date("2026-01-01T00:00:00Z") }, mssql.DateTime2],
    ...(["string", "integer", "bigint", "boolean", "binary", "date"] as const).map(
      (type, index) =>
        [
          { name: "empty", type, value: null },
          [mssql.NVarChar, mssql.Int, mssql.BigInt, mssql.Bit, mssql.VarBinary, mssql.DateTime2][
            index
          ],
        ] as const,
    ),
  ] satisfies ReadonlyArray<readonly [MetadataParameter, unknown]>)(
    "按声明类型绑定 $0.type 参数 $0.name",
    async (parameter, expectedType) => {
      const database = await SqlServerMetadataDatabase.connect(config);
      const sql = `SELECT @${parameter.name} AS value`;
      await database.execute({ sql, parameters: [parameter] });
      expect(driver.request.input).toHaveBeenCalledWith(
        parameter.name,
        expectedType,
        parameter.value,
      );
      expect(driver.request.query).toHaveBeenCalledWith(sql);
    },
  );

  it("保留返回记录和影响行数，写入没有记录集时返回空列表", async () => {
    const database = await SqlServerMetadataDatabase.connect(config);
    driver.request.query
      .mockResolvedValueOnce({ recordset: [{ id: 1 }], rowsAffected: [1] })
      .mockResolvedValueOnce({ rowsAffected: [2] });
    await expect(database.execute({ sql: "SELECT id FROM test", parameters: [] })).resolves.toEqual(
      { rows: [{ id: 1 }], rowsAffected: [1] },
    );
    await expect(
      database.execute({ sql: "UPDATE test SET id = 1", parameters: [] }),
    ).resolves.toEqual({ rows: [], rowsAffected: [2] });
  });

  it("查询错误保留原始原因", async () => {
    const database = await SqlServerMetadataDatabase.connect(config);
    const failure = new Error("查询失败");
    driver.request.query.mockRejectedValue(failure);
    await expect(database.execute({ sql: "SELECT 1", parameters: [] })).rejects.toBe(failure);
  });

  it("健康探针分别报告成功与失败", async () => {
    const database = await SqlServerMetadataDatabase.connect(config);
    await expect(database.checkHealth()).resolves.toBe("healthy");
    driver.request.query.mockRejectedValue(new Error("连接中断"));
    await expect(database.checkHealth()).resolves.toBe("unhealthy");
    expect(driver.request.query).toHaveBeenCalledWith("SELECT 1 AS metadata_database_health");
  });
});
