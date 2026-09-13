import type { DataSourceConnector } from "../connectors/connector";
import type { DataSourceConfig } from "./data-source-types";
import type {
  DataSourceSecretResolver,
  ResolvedDataSourceSecret,
} from "../secrets/secret-resolver";

/** 读取已启用数据源配置的最小能力。 */
interface DataSourceConfigLookup {
  /** 返回可运行配置；不存在或停用时返回 undefined。 */
  findEnabledBySourceId(sourceId: string): Promise<DataSourceConfig | undefined>;
}

/** 根据已校验配置和已解密凭据创建一个业务数据源连接器。 */
interface DataSourceConnectorFactory {
  /** 创建绑定单个 source_id 的连接器及其独立连接池。 */
  create(config: DataSourceConfig, secret: ResolvedDataSourceSecret): Promise<DataSourceConnector>;
}

/** 管理按 source_id 隔离的业务连接器实例及其生命周期。 */
class DataSourceManager {
  // 缓存初始化 Promise，让同一 source_id 的并发访问共享正在创建的实例。
  private readonly connectors = new Map<string, Promise<DataSourceConnector>>();
  private readonly connectorSecretRefs = new Map<string, string>();

  constructor(
    private readonly sourceLookup: DataSourceConfigLookup,
    private readonly secretResolver: DataSourceSecretResolver,
    private readonly connectorFactory: DataSourceConnectorFactory,
  ) {}

  /** 获取缓存连接器；同一数据源并发首次访问只创建一次连接器。 */
  async get(sourceId: string): Promise<DataSourceConnector> {
    const cached = this.connectors.get(sourceId);
    if (cached !== undefined) {
      return cached;
    }

    const created = this.createConnector(sourceId);
    this.connectors.set(sourceId, created);
    try {
      return await created;
    } catch (error) {
      // 仅清除本次失败的初始化，保留期间因失效重建而写入的新缓存。
      if (this.connectors.get(sourceId) === created) {
        this.connectors.delete(sourceId);
      }
      throw error;
    }
  }

  /** 关闭并移除一条数据源的连接器，供配置更新和停用流程调用。 */
  async invalidate(sourceId: string): Promise<void> {
    const connector = this.connectors.get(sourceId);
    this.connectors.delete(sourceId);
    this.connectorSecretRefs.delete(sourceId);
    if (connector !== undefined) {
      await (await connector).close();
    }
  }

  /** 凭据更新后关闭全部使用该密钥引用的业务连接器。 */
  async invalidateBySecretRef(secretRef: string): Promise<void> {
    const sourceIds = [...this.connectorSecretRefs]
      .filter(([, configuredSecretRef]) => configuredSecretRef === secretRef)
      .map(([sourceId]) => sourceId);
    await Promise.all(sourceIds.map(async (sourceId) => this.invalidate(sourceId)));
  }

  /** 在 DAS 退出时释放所有已经创建的业务数据源资源。 */
  async close(): Promise<void> {
    const connectors = [...this.connectors.values()];
    this.connectors.clear();
    this.connectorSecretRefs.clear();
    // 尝试关闭全部实例后再报告失败，避免一个关闭错误中断其他资源的清理。
    const results = await Promise.allSettled(
      connectors.map(async (connector) => {
        await (await connector).close();
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  /** 解析配置与凭据后创建实例，确认工厂返回的数据源身份一致再登记凭据依赖。 */
  private async createConnector(sourceId: string): Promise<DataSourceConnector> {
    const config = await this.sourceLookup.findEnabledBySourceId(sourceId);
    if (config === undefined) {
      throw new Error(`数据源不存在或已停用: ${sourceId}`);
    }

    const secret = await this.secretResolver.resolve(config);
    const connector = await this.connectorFactory.create(config, secret);
    if (connector.sourceId !== config.sourceId || connector.kind !== config.connectorKind) {
      await connector.close();
      throw new Error(`连接器工厂返回了不匹配的数据源实例: ${sourceId}`);
    }
    this.connectorSecretRefs.set(config.sourceId, config.secretRef);
    return connector;
  }
}

export { DataSourceManager };
export type { DataSourceConfigLookup, DataSourceConnectorFactory };
