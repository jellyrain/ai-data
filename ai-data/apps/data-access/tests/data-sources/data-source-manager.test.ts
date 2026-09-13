import { describe, expect, it } from "vitest";

import type { DataSourceConnector } from "../../src/connectors/connector";
import { DataSourceManager } from "../../src/data-sources/data-source-manager";
import type { DataSourceConfig } from "../../src/data-sources/data-source-types";
import type {
  DataSourceSecretResolver,
  ResolvedDataSourceSecret,
} from "../../src/secrets/secret-resolver";

const sourceConfig: DataSourceConfig = {
  sourceId: "clinical_reporting",
  connectorKind: "sqlserver",
  secretRef: "secret-clinical",
  targetDatabase: "clinical",
  timeoutMs: 15000,
  connectionPoolLimit: 10,
  concurrencyLimit: 5,
  rowLimit: 1000,
  costLimit: 50000,
};

// 用工厂创建次数、实例身份和关闭回调检查缓存生命周期，连接器替身不建立真实连接池。
describe("运行时数据源管理器", () => {
  it("按 source_id 缓存连接器实例", async () => {
    const created: DataSourceConnector[] = [];
    const manager = new DataSourceManager(
      createSourceLookup(sourceConfig),
      createSecretResolver(),
      {
        async create() {
          const connector = createConnector();
          created.push(connector);
          return connector;
        },
      },
    );

    const first = await manager.get("clinical_reporting");
    const second = await manager.get("clinical_reporting");

    expect(first).toBe(second);
    expect(created).toHaveLength(1);
  });

  it("并发首次请求只创建一个连接器", async () => {
    let creationCount = 0;
    const manager = new DataSourceManager(
      createSourceLookup(sourceConfig),
      createSecretResolver(),
      {
        async create() {
          creationCount += 1;
          await Promise.resolve();
          return createConnector();
        },
      },
    );

    const connectors = await Promise.all([
      manager.get("clinical_reporting"),
      manager.get("clinical_reporting"),
      manager.get("clinical_reporting"),
    ]);

    expect(creationCount).toBe(1);
    expect(connectors[0]).toBe(connectors[1]);
    expect(connectors[1]).toBe(connectors[2]);
  });

  it("复用凭据并为不同目标库创建独立连接器", async () => {
    const archiveConfig: DataSourceConfig = {
      ...sourceConfig,
      sourceId: "clinical_archive",
      targetDatabase: "clinical_archive",
    };
    const createdConfigs: DataSourceConfig[] = [];
    const manager = new DataSourceManager(
      createSourceLookup(sourceConfig, archiveConfig),
      createSecretResolver(),
      {
        async create(config) {
          createdConfigs.push(config);
          return createConnector(() => undefined, config.sourceId);
        },
      },
    );

    const reporting = await manager.get(sourceConfig.sourceId);
    const archive = await manager.get(archiveConfig.sourceId);

    expect(reporting).not.toBe(archive);
    expect(createdConfigs).toMatchObject([
      { secretRef: "secret-clinical", targetDatabase: "clinical" },
      { secretRef: "secret-clinical", targetDatabase: "clinical_archive" },
    ]);
  });

  it("失效时关闭已有连接器", async () => {
    let closed = false;
    const manager = new DataSourceManager(
      createSourceLookup(sourceConfig),
      createSecretResolver(),
      {
        async create() {
          return createConnector(() => {
            closed = true;
          });
        },
      },
    );

    await manager.get("clinical_reporting");
    await manager.invalidate("clinical_reporting");

    expect(closed).toBe(true);
  });

  it("退出时关闭全部已创建的连接器", async () => {
    let closed = 0;
    const anotherSource: DataSourceConfig = { ...sourceConfig, sourceId: "clinical_archive" };
    const manager = new DataSourceManager(
      createSourceLookup(sourceConfig, anotherSource),
      createSecretResolver(),
      {
        async create(config) {
          return createConnector(() => {
            closed += 1;
          }, config.sourceId);
        },
      },
    );

    await manager.get(sourceConfig.sourceId);
    await manager.get(anotherSource.sourceId);
    await manager.close();

    expect(closed).toBe(2);
  });
});

/** 构造已启用数据源配置的读取替身。 */
function createSourceLookup(...configs: DataSourceConfig[]) {
  return {
    async findEnabledBySourceId(sourceId: string) {
      return configs.find((config) => config.sourceId === sourceId);
    },
  };
}

/** 构造解密完成的连接配置替身。 */
function createSecretResolver(): DataSourceSecretResolver {
  return {
    async resolve(): Promise<ResolvedDataSourceSecret> {
      return {
        connectorKind: "sqlserver",
        host: "127.0.0.1",
        port: 1433,
        user: "reader",
        password: "secret",
      };
    },
  };
}

/** 构造无需真实业务数据源的连接器替身。 */
function createConnector(
  onClose: () => void = () => undefined,
  sourceId = "clinical_reporting",
): DataSourceConnector {
  return {
    sourceId,
    kind: "sqlserver",
    async checkHealth() {
      return { source_id: sourceId, status: "healthy", checked_at: "2026-08-28 10:00:00" };
    },
    async discoverCatalog() {
      return [];
    },
    async execute() {
      throw new Error("测试连接器不执行查询");
    },
    async close() {
      onClose();
    },
  };
}
