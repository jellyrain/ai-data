import mssql from "mssql";

import { applySqlServerMigrations } from "./sqlserver-migrations";
import type {
  MetadataConnectionConfig,
  MetadataDatabaseHealthChecker,
  MetadataDatabaseStatus,
  MetadataQueryExecutor,
  MetadataQueryResult,
  MetadataStatement,
} from "../metadata-types";

/** SQL Server 元数据库连接池的实现。业务应用各自创建独立实例。 */
class SqlServerMetadataDatabase implements MetadataDatabaseHealthChecker, MetadataQueryExecutor {
  private constructor(private readonly pool: mssql.ConnectionPool) {}

  /** 创建并验证 SQL Server 元数据库连接池。 */
  static async connect(config: MetadataConnectionConfig): Promise<SqlServerMetadataDatabase> {
    const pool = new mssql.ConnectionPool({
      server: config.server,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeout: config.options.connection_timeout_ms,
      requestTimeout: config.options.request_timeout_ms,
      pool: {
        max: config.options.pool.max,
        min: config.options.pool.min,
        idleTimeoutMillis: config.options.pool.idle_timeout_ms,
      },
      options: {
        encrypt: config.options.encrypt,
        trustServerCertificate: config.options.trust_server_certificate,
      },
    });

    try {
      await pool.connect();
      return new SqlServerMetadataDatabase(pool);
    } catch (error) {
      await pool.close();
      throw error;
    }
  }

  /** 使用最小只读语句验证 SQL Server 元数据库可用性。 */
  async checkHealth(): Promise<MetadataDatabaseStatus> {
    try {
      await this.pool.request().query("SELECT 1 AS metadata_database_health");
      return "healthy";
    } catch {
      return "unhealthy";
    }
  }

  /** 执行仓储定义的固定参数化 SQL。 */
  async execute<T extends Record<string, unknown>>(
    statement: MetadataStatement,
  ): Promise<MetadataQueryResult<T>> {
    const request = this.pool.request();

    for (const parameter of statement.parameters) {
      switch (parameter.type) {
        case "string":
          request.input(parameter.name, mssql.NVarChar, parameter.value);
          break;
        case "integer":
          request.input(parameter.name, mssql.Int, parameter.value);
          break;
        case "bigint":
          request.input(parameter.name, mssql.BigInt, parameter.value);
          break;
        case "boolean":
          request.input(parameter.name, mssql.Bit, parameter.value);
          break;
        case "binary":
          request.input(parameter.name, mssql.VarBinary, parameter.value);
          break;
        case "date":
          request.input(parameter.name, mssql.DateTime2, parameter.value);
          break;
      }
    }

    const result = await request.query<T>(statement.sql);
    return { rows: result.recordset ?? [], rowsAffected: result.rowsAffected };
  }

  /** 执行应用提供目录中的 SQL Server 元数据库迁移。 */
  async initializeSchema(migrationsDirectory: string): Promise<void> {
    await applySqlServerMigrations(
      {
        executeBatch: async (sql) => {
          await this.pool.request().batch(sql);
        },
      },
      migrationsDirectory,
    );
  }

  /** 关闭 SQL Server 元数据库连接池。 */
  async close(): Promise<void> {
    await this.pool.close();
  }
}

export { SqlServerMetadataDatabase };
