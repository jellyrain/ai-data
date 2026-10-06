import { describe, expect, it, vi } from "vitest";
import { DatabaseConnectorFactory } from "../../src/connectors/database-connector-factory";
import { DatabaseServerTargetDiscovery } from "../../src/data-sources/database-target-discovery";
const { connections } = vi.hoisted(() => ({
  connections: [] as Array<{ options: Record<string, unknown> }>,
}));
vi.mock("mssql", () => ({
  default: {
    ConnectionPool: class {
      constructor(config: { options: Record<string, unknown> }) {
        connections.push(config);
      }
      async connect() {
        return this;
      }
      async close() {}
      request() {
        return { query: async () => ({ recordset: [{ database_name: "clinical" }] }) };
      }
    },
  },
}));
const source = {
  sourceId: "clinical",
  connectorKind: "sqlserver" as const,
  secretRef: "reader",
  targetDatabase: "clinical",
  timeoutMs: 1000,
  connectionPoolLimit: 1,
  concurrencyLimit: 1,
  rowLimit: 100,
  costLimit: 1,
};
const secret = {
  connectorKind: "sqlserver" as const,
  host: "sql.test",
  port: 1433,
  user: "reader",
  password: "private",
};
describe("SQL Server 发现与业务连接参数", () => {
  it("明确保存的 Web 选项优先于文件配置且两种连接一致", async () => {
    connections.length = 0;
    const configured = {
      ...secret,
      sqlserver_transport: { encrypt: true, trust_server_certificate: true },
    };
    await new DatabaseServerTargetDiscovery().listDatabaseTargets(configured, {});
    const connector = await new DatabaseConnectorFactory({
      clinical: { encrypt: false, trust_server_certificate: false },
    }).create(source, configured);
    expect(
      connections.map((row) => ({
        encrypt: row.options.encrypt,
        trustServerCertificate: row.options.trustServerCertificate,
      })),
    ).toEqual([
      { encrypt: true, trustServerCertificate: true },
      { encrypt: true, trustServerCertificate: true },
    ]);
    await connector.close();
  });
  it("旧凭据的发现沿用默认值，已配置业务源保留文件选项", async () => {
    connections.length = 0;
    await new DatabaseServerTargetDiscovery().listDatabaseTargets(secret, {});
    const connector = await new DatabaseConnectorFactory({
      clinical: { encrypt: false, trust_server_certificate: true },
    }).create(source, secret);
    expect(connections[0]?.options).toMatchObject({ encrypt: true, trustServerCertificate: false });
    expect(connections[1]?.options).toMatchObject({ encrypt: false, trustServerCertificate: true });
    await connector.close();
  });
});
