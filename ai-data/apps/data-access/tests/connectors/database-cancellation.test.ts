import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseDriver } from "../../src/connectors/database-drivers";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const state = vi.hoisted(() => ({
  events: [] as string[],
  query: undefined as undefined | (() => Promise<unknown>),
  acquire: undefined as undefined | (() => Promise<void>),
  cancel: undefined as undefined | (() => void),
  requests: [] as Array<Record<string, unknown>>,
  oracle: undefined as undefined | { callTimeout: number },
  failHealth: false,
}));
function result() {
  return { rows: [], fields: [], metaData: [], recordset: Object.assign([], { columns: {} }) };
}
vi.mock("mssql", () => ({
  default: {
    ConnectionPool: class {
      async connect() {
        return this;
      }
      request() {
        const request = {
          input() {},
          async query() {
            state.events.push("query");
            return state.query?.() ?? result();
          },
          cancel() {
            state.events.push("cancel");
            state.cancel?.();
          },
        };
        state.requests.push(request);
        return request;
      }
      async close() {
        state.events.push("pool.close");
      }
    },
  },
}));
vi.mock("mysql2/promise", () => ({
  default: {
    createPool() {
      return {
        async query() {
          if (state.failHealth) throw new Error("初始化探测失败");
          return [[], []];
        },
        async getConnection() {
          await state.acquire?.();
          state.events.push("acquired");
          const stream = Object.assign(new EventEmitter(), {
            destroyed: false,
            destroy() {
              this.destroyed = true;
              state.events.push("socket.destroy");
              queueMicrotask(() => {
                state.events.push("socket.close");
                stream.emit("close");
              });
              return this;
            },
          });
          return {
            connection: { stream },
            async query(sql: string) {
              if (sql.startsWith("SET ")) return [[], []];
              state.events.push("query");
              return state.query?.() ?? [[], []];
            },
            destroy() {
              state.events.push("destroy");
            },
            release() {
              state.events.push("release");
            },
          };
        },
        async end() {
          state.events.push("pool.close");
        },
      };
    },
  },
}));
vi.mock("pg", () => ({
  types: { getTypeParser: () => (value: string) => value },
  Pool: class {
    async query(sql: string) {
      if (state.failHealth) throw new Error("初始化探测失败");
      if (sql.includes("das_health")) return result();
      state.events.push("query");
      return state.query?.() ?? result();
    }
    async connect() {
      await state.acquire?.();
      state.events.push("acquired");
      return {
        async query() {
          state.events.push("query");
          return state.query?.() ?? result();
        },
        async end() {
          state.events.push("end");
          state.cancel?.();
        },
        release(destroy?: boolean) {
          state.events.push(destroy ? "release.destroy" : "release");
        },
      };
    }
    async end() {
      state.events.push("pool.close");
    }
  },
}));
vi.mock("oracledb", () => ({
  default: {
    OUT_FORMAT_OBJECT: 1,
    async createPool() {
      return {
        async getConnection() {
          await state.acquire?.();
          state.events.push("acquired");
          const connection = {
            callTimeout: 0,
            async execute() {
              if (state.failHealth) throw new Error("初始化探测失败");
              state.events.push("query");
              return state.query?.() ?? result();
            },
            async breakExecution() {
              state.events.push("break");
              state.cancel?.();
            },
            async close() {
              state.events.push("close");
            },
          };
          state.oracle = connection;
          return connection;
        },
        async close() {
          state.events.push("pool.close");
        },
      };
    },
  },
}));

const config: DataSourceConfig = {
  sourceId: "test",
  connectorKind: "sqlserver",
  secretRef: "test",
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
const kinds = ["sqlserver", "mysql", "postgresql", "oracle"] as const;

/** 模拟驱动已开始工作，结束点由测试或原生取消回调控制。 */
function pendingQuery() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  state.query = () => promise;
  state.cancel = () => reject(new Error("驱动工作已中断"));
  return { resolve, reject };
}

describe("数据库查询原生取消与资源归还", () => {
  beforeEach(() => {
    state.events = [];
    state.query = undefined;
    state.acquire = undefined;
    state.cancel = undefined;
    state.requests = [];
    state.oracle = undefined;
    state.failHealth = false;
  });
  afterEach(() => vi.useRealTimers());

  it.each(kinds)("%s 查询期限到达时调用原生中断并释放所借资源", async (kind) => {
    vi.useFakeTimers();
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: kind });
    state.events = [];
    pendingQuery();
    const executing = driver.query("SELECT slow", [], { timeoutMs: 40 });
    const rejected = expect(executing).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    expect(state.events).toContain(
      { sqlserver: "cancel", mysql: "socket.destroy", postgresql: "end", oracle: "break" }[kind],
    );
    if (kind === "mysql") {
      expect(state.events).toContain("destroy");
      expect(state.events).toContain("socket.close");
      expect(state.events).not.toContain("release");
    }
    if (kind === "postgresql") expect(state.events).toContain("release.destroy");
    if (kind === "oracle") expect(state.events).toContain("close");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(kinds)("%s 接收调用方取消并移除其监听器", async (kind) => {
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: kind });
    pendingQuery();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const executing = driver.query("SELECT slow", [], { signal: controller.signal });
    const rejected = expect(executing).rejects.toMatchObject({ code: "CANCELLED" });
    await vi.waitFor(() => expect(state.events).toContain("query"));
    controller.abort();
    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["mysql", "postgresql", "oracle"] as const)(
    "%s 借出前取消后，晚到连接会归还且业务 SQL 不执行",
    async (kind) => {
      const driver = await createDatabaseDriver(config, { ...secret, connectorKind: kind });
      state.events = [];
      let acquired!: () => void;
      state.acquire = () =>
        new Promise<void>((resolve) => {
          acquired = resolve;
        });
      const controller = new AbortController();
      const executing = driver.query("SELECT slow", [], { signal: controller.signal });
      const rejected = expect(executing).rejects.toMatchObject({ code: "CANCELLED" });
      controller.abort();
      acquired();
      await rejected;
      expect(state.events).not.toContain("query");
      expect(state.events).toContain(kind === "oracle" ? "close" : "release");
    },
  );

  it("SQL Server 请求携带本次超时，取消回调完成前保留驱动 Promise", async () => {
    vi.useFakeTimers();
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "sqlserver" });
    const pending = pendingQuery();
    state.cancel = () => undefined;
    const controller = new AbortController();
    let completed = false;
    const executing = driver.query("SELECT slow", [], { signal: controller.signal, timeoutMs: 35 });
    void executing.catch(() => {
      completed = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(state.requests[0]).toMatchObject({ overrides: { requestTimeout: 35 } });
    expect(completed).toBe(false);
    pending.resolve(result());
    await expect(executing).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("Oracle 每次执行配置 callTimeout，正常结束归还连接", async () => {
    const driver = await createDatabaseDriver(config, { ...secret, connectorKind: "oracle" });
    await driver.query("SELECT", [], { timeoutMs: 75 });
    expect(state.oracle?.callTimeout).toBeGreaterThan(0);
    expect(state.oracle?.callTimeout).toBeLessThanOrEqual(75);
    expect(state.events.at(-1)).toBe("close");
  });

  it.each(["mysql", "postgresql", "oracle"] as const)(
    "%s 初始化探测失败关闭已创建的池",
    async (kind) => {
      state.failHealth = true;
      await expect(
        createDatabaseDriver(config, { ...secret, connectorKind: kind }),
      ).rejects.toThrow("初始化探测失败");
      expect(state.events).toContain("pool.close");
      if (kind === "oracle")
        expect(state.events.indexOf("close")).toBeLessThan(state.events.indexOf("pool.close"));
    },
  );
});
