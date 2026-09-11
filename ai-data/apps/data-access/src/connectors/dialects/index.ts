import type { ConnectorKind } from "../connector";
import type { DatabaseDialect } from "./database-dialect";
import { mysqlDialect } from "./mysql-dialect";
import { oracleDialect } from "./oracle-dialect";
import { postgresqlDialect } from "./postgresql-dialect";
import { sqlServerDialect } from "./sqlserver-dialect";

/** 返回数据库连接器对应的 SQL 方言。 */
function getDatabaseDialect(kind: Exclude<ConnectorKind, "http_api">): DatabaseDialect {
  switch (kind) {
    case "sqlserver":
      return sqlServerDialect;
    case "mysql":
      return mysqlDialect;
    case "postgresql":
      return postgresqlDialect;
    case "oracle":
      return oracleDialect;
  }
}

export { getDatabaseDialect, mysqlDialect, oracleDialect, postgresqlDialect, sqlServerDialect };
export type { DatabaseDialect } from "./database-dialect";
