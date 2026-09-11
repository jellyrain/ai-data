import mssql from "mssql";
import mysql from "mysql2/promise";
import oracledb from "oracledb";
import type { RowDataPacket } from "mysql2";
import { Pool as PgPool } from "pg";

import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";

/** 可在服务器级别读取目标数据库的已解析凭据。 */
type DatabaseServerSecret = Exclude<ResolvedDataSourceSecret, { connectorKind: "http_api" }>;

/** 管理端读取目标库时提供的 Oracle CDB 连接入口。 */
type DatabaseTargetDiscoveryInput = {
  oracleConnectType?: "sid" | "service_name";
  oracleConnectTarget?: string;
};

/** 一项可在管理端展示并用于创建 source_id 的数据库目标。 */
type DatabaseTarget = {
  name: string;
  connectTarget: string;
  connectType?: "sid" | "service_name";
};

/** 数据源管理服务读取可访问目标数据库的能力。 */
interface DatabaseTargetDiscovery {
  /** 返回当前登录账号能够访问的数据库目标及实际连接入口。 */
  listDatabaseTargets(
    secret: DatabaseServerSecret,
    input: DatabaseTargetDiscoveryInput,
  ): Promise<DatabaseTarget[]>;
}

/** 使用各数据库驱动的服务器级目录读取能力发现可访问目标库。 */
class DatabaseServerTargetDiscovery implements DatabaseTargetDiscovery {
  async listDatabaseTargets(
    secret: DatabaseServerSecret,
    input: DatabaseTargetDiscoveryInput,
  ): Promise<DatabaseTarget[]> {
    switch (secret.connectorKind) {
      case "sqlserver":
        return listSqlServerDatabases(secret);
      case "mysql":
        return listMysqlDatabases(secret);
      case "postgresql":
        return listPostgresqlDatabases(secret);
      case "oracle":
        return listOraclePluggableDatabases(secret, input);
    }
  }
}

/** 列出当前 SQL Server 登录可访问的在线数据库。 */
async function listSqlServerDatabases(
  secret: Extract<DatabaseServerSecret, { connectorKind: "sqlserver" }>,
): Promise<DatabaseTarget[]> {
  const pool = await new mssql.ConnectionPool({
    server: secret.host,
    port: secret.port,
    user: secret.user,
    password: secret.password,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: { encrypt: true, trustServerCertificate: false },
  }).connect();
  try {
    const result = await pool.request().query<{ database_name: string }>(`
      SELECT name AS database_name
      FROM sys.databases
      WHERE state = 0
      ORDER BY name;
    `);
    return result.recordset.map((row) => ({
      name: row.database_name,
      connectTarget: row.database_name,
    }));
  } finally {
    await pool.close();
  }
}

/** 列出当前 MySQL 登录可访问的数据库。 */
async function listMysqlDatabases(
  secret: Extract<DatabaseServerSecret, { connectorKind: "mysql" }>,
): Promise<DatabaseTarget[]> {
  const pool = mysql.createPool({
    host: secret.host,
    port: secret.port,
    user: secret.user,
    password: secret.password,
    connectionLimit: 1,
    waitForConnections: true,
    queueLimit: 0,
  });
  try {
    const [rows] = await pool.query<(RowDataPacket & { Database: string })[]>("SHOW DATABASES");
    return rows
      .map((row) => ({ name: row.Database, connectTarget: row.Database }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await pool.end();
  }
}

/** 列出当前 PostgreSQL 登录可连接的非模板数据库。 */
async function listPostgresqlDatabases(
  secret: Extract<DatabaseServerSecret, { connectorKind: "postgresql" }>,
): Promise<DatabaseTarget[]> {
  const pool = new PgPool({
    host: secret.host,
    port: secret.port,
    database: "postgres",
    user: secret.user,
    password: secret.password,
    max: 1,
  });
  try {
    const result = await pool.query<{ database_name: string }>(`
      SELECT datname AS database_name
      FROM pg_database
      WHERE datallowconn = true
        AND datistemplate = false
      ORDER BY datname;
    `);
    return result.rows.map((row) => ({
      name: row.database_name,
      connectTarget: row.database_name,
    }));
  } finally {
    await pool.end();
  }
}

/** 通过管理员填写的 CDB SID 或服务名，列出可访问 PDB 和对应服务名。 */
async function listOraclePluggableDatabases(
  secret: Extract<DatabaseServerSecret, { connectorKind: "oracle" }>,
  input: DatabaseTargetDiscoveryInput,
): Promise<DatabaseTarget[]> {
  if (input.oracleConnectType === undefined || input.oracleConnectTarget === undefined) {
    throw new Error("Oracle 发现目标库必须填写 CDB 的 SID 或 Service Name");
  }
  const connectString =
    input.oracleConnectType === "sid"
      ? `${secret.host}:${secret.port}:${input.oracleConnectTarget}`
      : `${secret.host}:${secret.port}/${input.oracleConnectTarget}`;
  const pool = await oracledb.createPool({
    connectString,
    user: secret.user,
    password: secret.password,
    poolMax: 1,
    poolMin: 0,
    poolTimeout: 1,
    stmtCacheSize: 1,
  });
  try {
    const connection = await pool.getConnection();
    try {
      const result = await connection.execute(
        `
        SELECT p.pdb_name AS database_name, MIN(s.name) AS connect_target
        FROM cdb_pdbs p
        JOIN cdb_services s ON s.pdb = p.pdb_name
        WHERE p.open_mode = 'READ WRITE'
          AND p.pdb_name <> 'PDB$SEED'
        GROUP BY p.pdb_name
        ORDER BY p.pdb_name
      `,
        [],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      return (result.rows ?? []).map((row) => ({
        name: String(row.DATABASE_NAME ?? row.database_name),
        connectTarget: String(row.CONNECT_TARGET ?? row.connect_target),
        connectType: "service_name" as const,
      }));
    } finally {
      await connection.close();
    }
  } finally {
    await pool.close();
  }
}

export { DatabaseServerTargetDiscovery };
export type {
  DatabaseServerSecret,
  DatabaseTarget,
  DatabaseTargetDiscovery,
  DatabaseTargetDiscoveryInput,
};
