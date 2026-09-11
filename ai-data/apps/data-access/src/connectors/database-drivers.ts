import mssql from "mssql";
import mysql from "mysql2/promise";
import oracledb from "oracledb";
import { Pool as PgPool } from "pg";

import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import type { DataSourceConfig } from "../metadata/metadata-records";
import type { DatabaseDriver, DatabaseParameter } from "./database-connector";

/** 读取 SQL Server、MySQL 或 PostgreSQL 数据源已配置的目标库。 */
function getTargetDatabase(config: DataSourceConfig): string {
  if (config.targetDatabase === undefined) {
    throw new Error(`数据源未配置目标数据库: ${config.sourceId}`);
  }
  return config.targetDatabase;
}

/** 根据管理员选择的连接方式生成 Oracle Easy Connect 目标。 */
function getOracleConnectString(config: DataSourceConfig, host: string, port: number): string {
  if (config.oracleConnectType === undefined || config.oracleConnectTarget === undefined) {
    throw new Error(`Oracle 数据源未配置连接目标: ${config.sourceId}`);
  }
  return config.oracleConnectType === "sid"
    ? `${host}:${port}:${config.oracleConnectTarget}`
    : `${host}:${port}/${config.oracleConnectTarget}`;
}

/** 创建 SQL Server 独立连接池驱动。 */
async function createSqlServerDriver(
  config: DataSourceConfig,
  secret: Extract<ResolvedDataSourceSecret, { connectorKind: "sqlserver" }>,
): Promise<DatabaseDriver> {
  const pool = await new mssql.ConnectionPool({
    server: secret.host,
    port: secret.port,
    database: getTargetDatabase(config),
    user: secret.user,
    password: secret.password,
    pool: { max: config.connectionPoolLimit, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: true, trustServerCertificate: false },
    requestTimeout: config.timeoutMs,
    connectionTimeout: config.timeoutMs,
  }).connect();
  return {
    async query(sql, parameters) {
      const request = pool.request();
      parameters.forEach((parameter, index) =>
        request.input(`p${index}`, getSqlServerParameterType(parameter.dataType), parameter.value),
      );
      const result = await request.query(sql);
      return { rows: result.recordset as Record<string, unknown>[] };
    },
    close: () => pool.close(),
  };
}

/** SQL Server 驱动按合同类型绑定参数，日期时间保留为文本供方言表达式转换。 */
function getSqlServerParameterType(dataType: DatabaseParameter["dataType"]) {
  switch (dataType) {
    case "integer":
      return mssql.Int;
    case "decimal":
      return mssql.Decimal(38, 10);
    case "boolean":
      return mssql.Bit;
    case "buffer":
      return mssql.VarBinary;
    default:
      return mssql.NVarChar;
  }
}

/** 创建 MySQL 独立连接池驱动。 */
async function createMysqlDriver(
  config: DataSourceConfig,
  secret: Extract<ResolvedDataSourceSecret, { connectorKind: "mysql" }>,
): Promise<DatabaseDriver> {
  const pool = mysql.createPool({
    host: secret.host,
    port: secret.port,
    database: getTargetDatabase(config),
    user: secret.user,
    password: secret.password,
    connectionLimit: config.connectionPoolLimit,
    waitForConnections: true,
    queueLimit: config.concurrencyLimit,
    connectTimeout: config.timeoutMs,
  });
  await pool.query("SELECT 1 AS das_health");
  return {
    async query(sql, parameters) {
      const [rows, fields] = await pool.query(
        sql,
        parameters.map((parameter) => parameter.value),
      );
      return {
        rows: (Array.isArray(rows) ? rows : []) as Record<string, unknown>[],
        columns: Array.isArray(fields) ? fields.map((field) => ({ name: field.name })) : undefined,
      };
    },
    close: () => pool.end(),
  };
}

/** 创建 PostgreSQL 独立连接池驱动。 */
async function createPostgresqlDriver(
  config: DataSourceConfig,
  secret: Extract<ResolvedDataSourceSecret, { connectorKind: "postgresql" }>,
): Promise<DatabaseDriver> {
  const pool = new PgPool({
    host: secret.host,
    port: secret.port,
    database: getTargetDatabase(config),
    user: secret.user,
    password: secret.password,
    max: config.connectionPoolLimit,
    connectionTimeoutMillis: config.timeoutMs,
    statement_timeout: config.timeoutMs,
  });
  await pool.query("SELECT 1 AS das_health");
  return {
    async query(sql, parameters) {
      const result = await pool.query(
        sql,
        parameters.map((parameter) => parameter.value),
      );
      return {
        rows: result.rows as Record<string, unknown>[],
        columns: result.fields.map((field) => ({ name: field.name })),
      };
    },
    close: () => pool.end(),
  };
}

/** 创建 Oracle 独立连接池驱动；connectString 只在适配器内部按配置拼接。 */
async function createOracleDriver(
  config: DataSourceConfig,
  secret: Extract<ResolvedDataSourceSecret, { connectorKind: "oracle" }>,
): Promise<DatabaseDriver> {
  const pool = await oracledb.createPool({
    connectString: getOracleConnectString(config, secret.host, secret.port),
    user: secret.user,
    password: secret.password,
    poolMax: config.connectionPoolLimit,
    poolMin: 0,
    poolTimeout: 60,
    stmtCacheSize: 30,
  });
  const connection = await pool.getConnection();
  await connection.execute("SELECT 1 AS das_health FROM dual");
  await connection.close();
  return {
    async query(sql, parameters) {
      const current = await pool.getConnection();
      try {
        const result = await current.execute(
          sql,
          parameters.map((parameter) => parameter.value),
          {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
          },
        );
        const rows = (result.rows ?? []) as Record<string, unknown>[];
        return {
          rows,
          columns: result.metaData?.map((field: { name: string }) => ({ name: field.name })),
        };
      } finally {
        await current.close();
      }
    },
    close: () => pool.close(10),
  };
}

/** 根据已解析凭据创建对应数据库驱动。 */
async function createDatabaseDriver(
  config: DataSourceConfig,
  secret: ResolvedDataSourceSecret,
): Promise<DatabaseDriver> {
  switch (secret.connectorKind) {
    case "sqlserver":
      return createSqlServerDriver(config, secret);
    case "mysql":
      return createMysqlDriver(config, secret);
    case "postgresql":
      return createPostgresqlDriver(config, secret);
    case "oracle":
      return createOracleDriver(config, secret);
    case "http_api":
      throw new Error("HTTP API 凭据不能创建数据库驱动");
  }
}

export {
  createDatabaseDriver,
  createMysqlDriver,
  createOracleDriver,
  createPostgresqlDriver,
  createSqlServerDriver,
  getOracleConnectString,
};
export type { DatabaseParameter };
