import type { Duplex } from "node:stream";

import mssql from "mssql";
import mysql, { type FieldPacket } from "mysql2/promise";
import oracledb from "oracledb";
import { Pool as PgPool, types as pgTypes } from "pg";

import type { ResolvedDataSourceSecret } from "../secrets/secret-resolver";
import type { DataSourceConfig } from "../data-sources/data-source-types";
import type { DatabaseColumn, DatabaseDriver, DatabaseParameter } from "./database-connector";
import { runDatabaseQuery } from "./database-query-control";
import { queryAbortError } from "./query-resource-error";

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
    options: { encrypt: true, trustServerCertificate: false, useUTC: true },
    requestTimeout: config.timeoutMs,
    connectionTimeout: config.timeoutMs,
  }).connect();
  return {
    async query(sql, parameters, options = {}) {
      return runDatabaseQuery(options, config.timeoutMs, async (control) => {
        const request = pool.request();
        // mssql 12 的 Request.overrides 被 tedious 转交给当前请求的 setTimeout。
        Object.assign(request, { overrides: { requestTimeout: control.remainingMs } });
        parameters.forEach((parameter, index) =>
          request.input(
            `p${index}`,
            getSqlServerParameterType(parameter.dataType),
            parameter.value,
          ),
        );
        const removeCancel = control.onCancel(() => {
          request.cancel();
        });
        try {
          const result = await request.query(sql);
          if (Array.isArray(result.recordsets) && result.recordsets.length > 1) {
            throw new Error("数据库查询返回多个结果集");
          }
          return {
            rows: result.recordset as Record<string, unknown>[],
            columns: Object.values(result.recordset.columns).map((field): DatabaseColumn => {
              const factory = typeof field.type === "function" ? field.type : field.type.type;
              const dataType =
                Object.entries(mssql.TYPES).find(([, candidate]) => candidate === factory)?.[0] ??
                "string";
              return {
                name: field.name,
                dataType,
                nullable: field.nullable,
                ...(dataType === "Time" ? { dateMode: "utc_time" as const } : {}),
                ...(["Date", "DateTime", "DateTime2", "SmallDateTime"].includes(dataType)
                  ? { dateMode: "utc_wall" as const }
                  : {}),
              };
            }),
          };
        } finally {
          removeCancel();
        }
      });
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
      // 当前统一采用精度 38、小数位 10 的绑定类型，未按具体字段精度细分。
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
    // 数值先按文本取得以便统一检查范围，无时区日期避免进程时区参与转换。
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  try {
    await pool.query("SELECT 1 AS das_health");
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async query(sql, parameters, options = {}) {
      return runDatabaseQuery(options, config.timeoutMs, async (control) => {
        const connection = await pool.getConnection();
        let wasDestroyed = false;
        let removeCancel = () => {};
        let removeClose = () => {};
        try {
          control.throwIfCancelled();
          // mysql2 3.24 的池连接 destroy 会移除连接并结束流；主动销毁 socket 完成物理中断。
          const stream = (connection.connection as unknown as { stream: Duplex }).stream;
          const closed = new Promise<never>((_resolve, reject) => {
            const onClose = () => {
              if (control.signal.aborted) reject(queryAbortError(control.signal));
            };
            stream.once("close", onClose);
            removeClose = () => stream.removeListener("close", onClose);
          });
          // 先注册关闭观察者，再执行真实销毁；最终释放以 socket close 为依据。
          removeCancel = control.onCancel(() => {
            wasDestroyed = true;
            const closing = new Promise<void>((resolve) => stream.once("close", resolve));
            connection.destroy();
            stream.destroy();
            return closing;
          });
          // TIMESTAMP 由当前会话时区生成文本；每次借用都准备同一连接，再执行业务查询。
          await Promise.race([connection.query("SET time_zone = '+08:00'"), closed]);
          control.throwIfCancelled();
          const [rows, fields] = await Promise.race([
            connection.query(
              sql,
              parameters.map((parameter) => parameter.value),
            ),
            closed,
          ]);
          return normalizeMysqlResult(rows, fields);
        } finally {
          removeCancel();
          await control.finishCancellation();
          removeClose();
          if (!wasDestroyed) connection.release();
        }
      });
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
    types: {
      getTypeParser(oid, format) {
        if ((oid === 1082 || oid === 1114) && format !== "binary") return (value: string) => value;
        return pgTypes.getTypeParser(oid, format);
      },
    },
  });
  try {
    await pool.query("SELECT 1 AS das_health");
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async query(sql, parameters, options = {}) {
      return runDatabaseQuery(options, config.timeoutMs, async (control) => {
        const client = await pool.connect();
        let wasEnded = false;
        let removeCancel = () => {};
        try {
          control.throwIfCancelled();
          // 专用借出连接的 end 在活动查询期间销毁 socket，并使该查询 Promise 结束。
          removeCancel = control.onCancel(async () => {
            wasEnded = true;
            await client.end();
          });
          const result = await client.query(
            sql,
            parameters.map((parameter) => parameter.value),
          );
          return {
            rows: result.rows as Record<string, unknown>[],
            columns: result.fields.map((field) => ({
              name: field.name,
              dataType: postgresqlTypeNames[field.dataTypeID] ?? "string",
            })),
          };
        } finally {
          removeCancel();
          await control.finishCancellation();
          client.release(wasEnded);
        }
      });
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
    queueMax: config.concurrencyLimit,
    queueTimeout: config.timeoutMs,
  });
  try {
    const connection = await pool.getConnection();
    try {
      connection.callTimeout = config.timeoutMs;
      await connection.execute("SELECT 1 AS das_health FROM dual");
    } finally {
      await connection.close();
    }
  } catch (error) {
    await pool.close(0);
    throw error;
  }
  return {
    async query(sql, parameters, options = {}) {
      return runDatabaseQuery(options, config.timeoutMs, async (control) => {
        const current = await pool.getConnection();
        let removeCancel = () => {};
        try {
          control.throwIfCancelled();
          current.callTimeout = control.remainingMs;
          removeCancel = control.onCancel(() => current.breakExecution());
          const result = await current.execute(
            sql,
            parameters.map((parameter) => parameter.value),
            {
              outFormat: oracledb.OUT_FORMAT_OBJECT,
              fetchTypeHandler: (field) => {
                // NUMBER 文本在统一转换层检查；LOB 在连接归还前取得完整的基础值。
                if (
                  field.dbTypeName === "NUMBER" ||
                  field.dbTypeName === "CLOB" ||
                  field.dbTypeName === "NCLOB"
                )
                  return { type: oracledb.DB_TYPE_VARCHAR };
                if (field.dbTypeName === "BLOB") return { type: oracledb.DB_TYPE_RAW };
                return undefined;
              },
            },
          );
          const rows = (result.rows ?? []) as Record<string, unknown>[];
          return {
            rows,
            columns: result.metaData?.map((field): DatabaseColumn => {
              const nativeType = field.dbTypeName ?? "string";
              const isWallTime = nativeType === "DATE" || nativeType === "TIMESTAMP";
              return {
                name: field.name,
                dataType:
                  nativeType === "NUMBER" && field.scale === 0
                    ? "integer"
                    : isWallTime
                      ? "datetime"
                      : nativeType,
                nullable: field.nullable,
                ...(isWallTime ? { dateMode: "local_wall" as const } : {}),
              };
            }),
          };
        } finally {
          removeCancel();
          await control.finishCancellation();
          // 归还本次借出的连接，连接池继续供同一 source_id 的后续查询复用。
          await current.close();
        }
      });
    },
    // 关闭时给借出的连接预留 10 秒排空时间。
    close: () => pool.close(10),
  };
}

/** PostgreSQL 协议内置 OID；表达式和空结果均由字段元数据确定类型。 */
const postgresqlTypeNames: Record<number, string> = {
  16: "boolean",
  17: "bytea",
  20: "bigint",
  21: "smallint",
  23: "integer",
  26: "integer",
  700: "real",
  701: "double",
  790: "money",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1266: "timetz",
  1700: "numeric",
};

/** 将 MySQL 普通结果与 CALL 的单表格结果映射到同一驱动合同。 */
function normalizeMysqlResult(rows: unknown, fields: unknown) {
  // CALL 使用嵌套记录集并附带状态包；空表格仍由对应 fields 数组提供元数据。
  if (Array.isArray(rows) && rows.some(Array.isArray)) {
    const indexes = rows.flatMap((item, index) => (Array.isArray(item) ? [index] : []));
    if (indexes.length > 1) throw new Error("数据库查询返回多个结果集");
    const index = indexes[0]!;
    const columns = Array.isArray(fields) ? fields[index] : undefined;
    return {
      rows: rows[index] as Record<string, unknown>[],
      columns: Array.isArray(columns) ? (columns as FieldPacket[]).map(mapMysqlColumn) : undefined,
    };
  }
  return {
    rows: (Array.isArray(rows) ? rows : []) as Record<string, unknown>[],
    columns: Array.isArray(fields) ? (fields as FieldPacket[]).map(mapMysqlColumn) : undefined,
  };
}

/** MySQL 协议类型码与字符集联合确定文本/二进制，BIT(1) 映射为布尔。 */
function mapMysqlColumn(field: FieldPacket): DatabaseColumn {
  const type = field.columnType ?? field.type;
  const names: Record<number, string> = {
    0: "decimal",
    1: "tinyint",
    2: "smallint",
    3: "int",
    4: "float",
    5: "double",
    7: "timestamp",
    8: "bigint",
    9: "mediumint",
    10: "date",
    11: "time",
    12: "datetime",
    13: "year",
    14: "date",
    246: "decimal",
  };
  let dataType = type === undefined ? "string" : (names[type] ?? "string");
  if (type === 16) dataType = field.columnLength === 1 ? "boolean" : "varbinary";
  if (
    type !== undefined &&
    [249, 250, 251, 252, 253, 254].includes(type) &&
    (field.characterSet ?? field.charsetNr) === 63
  )
    dataType = "varbinary";
  const isNotNull =
    typeof field.flags === "number" ? (field.flags & 1) !== 0 : field.flags.includes("NOT_NULL");
  return { name: field.name, dataType, nullable: !isNotNull };
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
