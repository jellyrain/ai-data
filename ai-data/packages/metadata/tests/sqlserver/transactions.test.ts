import { describe, expect, it, vi } from "vitest";
import { SqlServerMetadataDatabase } from "../../src/sqlserver/sqlserver-database";

const driver = vi.hoisted(() => {
  const request = {
    input: vi.fn(),
    query: vi.fn(async () => ({ recordset: [{ value: 7 }], rowsAffected: [1] })),
  };
  const transaction = {
    begin: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    request: vi.fn(() => request),
  };
  return {
    request,
    transaction,
    pool: { connect: vi.fn(), close: vi.fn(), transaction: vi.fn(() => transaction) },
  };
});
vi.mock("mssql", () => ({
  default: {
    ConnectionPool: class {
      constructor() {
        return driver.pool;
      }
    },
    NVarChar: "nvarchar",
  },
}));
const config = {
  server: "local",
  port: 1433,
  database: "test",
  user: "test",
  password: "test",
  options: {
    encrypt: false,
    trust_server_certificate: true,
    connection_timeout_ms: 1000,
    request_timeout_ms: 1000,
    pool: { max: 1, min: 0, idle_timeout_ms: 1000 },
  },
};

describe("元数据库业务事务", () => {
  it("参与仓储使用同一事务执行器，成功后提交返回结果", async () => {
    vi.clearAllMocks();
    const database = await SqlServerMetadataDatabase.connect(config);
    const result = await database.transaction(async (executor) => {
      await executor.execute({
        sql: "INSERT fixture VALUES (@value)",
        parameters: [{ name: "value", type: "string", value: "value" }],
      });
      return (await executor.execute({ sql: "SELECT value FROM fixture", parameters: [] })).rows;
    });
    expect(result).toEqual([{ value: 7 }]);
    expect(driver.transaction.begin).toHaveBeenCalledOnce();
    expect(driver.transaction.request).toHaveBeenCalledTimes(2);
    expect(driver.transaction.commit).toHaveBeenCalledOnce();
    expect(driver.transaction.rollback).not.toHaveBeenCalled();
  });
  it("业务操作失败时回滚并保留原始错误", async () => {
    vi.clearAllMocks();
    const database = await SqlServerMetadataDatabase.connect(config);
    const failure = new Error("write failed");
    await expect(
      database.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(driver.transaction.rollback).toHaveBeenCalledOnce();
    expect(driver.transaction.commit).not.toHaveBeenCalled();
  });
});
