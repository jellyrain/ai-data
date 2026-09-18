import { beforeEach, describe, expect, it, vi } from "vitest";
import type mssql from "mssql";

import { DatabaseConnectorFactory } from "../../src/connectors/database-connector-factory";
import { DefaultConnectorFactory } from "../../src/connectors/default-connector-factory";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";

const state = vi.hoisted(() => ({ pools: [] as Array<Record<string, unknown>> }));
vi.mock("mssql", async (original) => {
  const actual = await original<{ default: typeof mssql }>();
  return {
    default: {
      ...actual.default,
      ConnectionPool: class {
        constructor(options: Record<string, unknown>) {
          state.pools.push(options);
        }
        async connect() {
          return this;
        }
        async close() {}
      },
    },
  };
});

const config: DataSourceConfig = {
  sourceId: "clinical",
  connectorKind: "sqlserver",
  secretRef: "test-secret",
  targetDatabase: "reporting",
  timeoutMs: 1000,
  connectionPoolLimit: 1,
  concurrencyLimit: 1,
  rowLimit: 10,
  costLimit: 100,
};
const secret = {
  connectorKind: "sqlserver" as const,
  host: "test.invalid",
  port: 1433,
  user: "test",
  password: "test",
};
const mappingLookup = {
  findBySourceIdAndObjectId: async () => undefined,
  listBySourceId: async () => [],
};

// 前提：部署配置按 source_id 维护链路选项。操作：默认工厂创建业务连接池。预期：命中配置时完整转交 mssql，其余源沿用默认加密及证书验证。
describe("SQL Server 数据源链路配置", () => {
  beforeEach(() => {
    state.pools = [];
  });

  it("默认工厂把每个源的配置转为对应 SQL Server 连接池选项", async () => {
    const factory = new DefaultConnectorFactory(mappingLookup, {
      clinical: { encrypt: false, trust_server_certificate: true },
      reporting: { encrypt: true, trust_server_certificate: true },
    });
    const clinical = await factory.create(config, secret);
    const reporting = await factory.create({ ...config, sourceId: "reporting" }, secret);
    const unknown = await factory.create({ ...config, sourceId: "other" }, secret);
    expect(state.pools.map((pool) => pool.options)).toEqual([
      { encrypt: false, trustServerCertificate: true, useUTC: true },
      { encrypt: true, trustServerCertificate: true, useUTC: true },
      { encrypt: true, trustServerCertificate: false, useUTC: true },
    ]);
    await Promise.all([clinical.close(), reporting.close(), unknown.close()]);
  });

  it("数据库工厂可按源单独配置传输行为", async () => {
    const factory = new DatabaseConnectorFactory({
      clinical: { encrypt: false, trust_server_certificate: true },
    });
    const connector = await factory.create(config, secret);
    expect(state.pools[0]?.options).toEqual({
      encrypt: false,
      trustServerCertificate: true,
      useUTC: true,
    });
    await connector.close();
  });

  it("省略源配置时保持现有默认值", async () => {
    const factory = new DefaultConnectorFactory(mappingLookup);
    const connector = await factory.create(config, secret);
    expect(state.pools[0]?.options).toEqual({
      encrypt: true,
      trustServerCertificate: false,
      useUTC: true,
    });
    await connector.close();
  });
});
