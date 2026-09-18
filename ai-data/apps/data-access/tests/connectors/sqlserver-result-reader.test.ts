import { EventEmitter } from "node:events";
import type mssql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { readSqlServerResult } from "../../src/connectors/sqlserver-result-reader";

/** 模拟 mssql stream 的事件行为：error 事件后 query Promise 仍可正常完成。 */
function fixture(emitRows: (request: EventEmitter) => void) {
  const request = Object.assign(new EventEmitter(), {
    stream: false,
    cancel: vi.fn(),
    query: vi.fn(async () => {
      emitRows(request);
      return {};
    }),
  });
  return { request, typed: request as unknown as mssql.Request };
}

describe("SQL Server 受限逐行读取", () => {
  it("保留最终结果与一个探针，过程多余行不进入结果数组", async () => {
    const f = fixture((request) => {
      request.emit("recordset", { id: { name: "id" } });
      for (let id = 1; id <= 50000; id++) request.emit("row", { id });
    });
    const result = await readSqlServerResult(f.typed, "query", { maxRows: 3, maxBytes: 1000 });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(f.request.stream).toBe(true);
    expect(f.request.query).toHaveBeenCalledTimes(1);
    expect(f.request.listenerCount("row")).toBe(0);
  });
  it("UTF-8 字节超限时取消原生请求并保留资源错误", async () => {
    const f = fixture((request) => {
      request.emit("row", { text: "中文".repeat(50) });
      request.emit("error", new Error("cancelled"));
    });
    await expect(
      readSqlServerResult(f.typed, "query", { maxRows: 10, maxBytes: 100 }),
    ).rejects.toMatchObject({ code: "QUERY_LIMIT_EXCEEDED" });
    expect(f.request.cancel).toHaveBeenCalledTimes(1);
  });
  it("已发出行之后的驱动错误仍使整个查询失败", async () => {
    const f = fixture((request) => {
      request.emit("row", { id: 1 });
      request.emit("error", new Error("driver failure"));
    });
    await expect(
      readSqlServerResult(f.typed, "query", { maxRows: 10, maxBytes: 1000 }),
    ).rejects.toThrow("driver failure");
    expect(f.request.listenerCount("error")).toBe(0);
  });
  it("拒绝多个结果集，即使第一个结果集已达到保留上限", async () => {
    const f = fixture((request) => {
      request.emit("recordset", {});
      request.emit("row", { id: 1 });
      request.emit("recordset", {});
    });
    await expect(
      readSqlServerResult(f.typed, "query", { maxRows: 1, maxBytes: 100 }),
    ).rejects.toThrow("多个结果集");
  });
});
