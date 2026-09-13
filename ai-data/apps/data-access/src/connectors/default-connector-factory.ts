import type { DataSourceConfig } from "../data-sources/data-source-types";
import type { ApiDatasetMappingLookup } from "./http-api-connector";
import type { DataSourceConnectorFactory } from "../data-sources/data-source-manager";
import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import { DatabaseConnectorFactory } from "./database-connector-factory";
import { HttpApiConnector } from "./http-api-connector";

/** DAS 默认连接器工厂，按数据源类型分派数据库或 HTTP API 实现。 */
class DefaultConnectorFactory implements DataSourceConnectorFactory {
  private readonly databaseFactory = new DatabaseConnectorFactory();

  constructor(private readonly apiDatasetMappingLookup: ApiDatasetMappingLookup) {}

  /** 创建对应类型的独立连接器实例。 */
  async create(config: DataSourceConfig, secret: ResolvedDataSourceSecret) {
    if (secret.connectorKind === "http_api") {
      return new HttpApiConnector(config, secret, this.apiDatasetMappingLookup);
    }
    return this.databaseFactory.create(config, secret);
  }
}

export { DefaultConnectorFactory };
