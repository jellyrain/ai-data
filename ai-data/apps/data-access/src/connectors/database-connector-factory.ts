import type { DataSourceConfig } from "../metadata/metadata-records";
import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import { DatabaseConnector } from "./database-connector";
import { createDatabaseDriver } from "./database-drivers";
import type { DataSourceConnectorFactory } from "../data-sources/data-source-manager";
import { getDatabaseDialect } from "./dialects";

/** 使用真实数据库驱动创建业务连接器的默认工厂。 */
class DatabaseConnectorFactory implements DataSourceConnectorFactory {
  /** 为每个 source_id 创建独立数据库连接池和方言连接器。 */
  async create(
    config: DataSourceConfig,
    secret: ResolvedDataSourceSecret,
  ): Promise<DatabaseConnector> {
    if (secret.connectorKind === "http_api") {
      throw new Error("HTTP API 凭据不能由数据库连接器工厂创建");
    }
    const driver = await createDatabaseDriver(config, secret);
    return new DatabaseConnector(config, driver, getDatabaseDialect(secret.connectorKind));
  }
}

export { DatabaseConnectorFactory };
