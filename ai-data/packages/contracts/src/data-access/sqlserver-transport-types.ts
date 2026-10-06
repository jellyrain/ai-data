import type { z } from "zod";
import type {
  sqlServerTransportSchema,
  managedSqlServerTransportSchema,
  sqlServerTransportUpdateSchema,
} from "./sqlserver-transport";
/** 一条业务 SQL Server 连接的安全选项。 */
type SqlServerTransport = z.infer<typeof sqlServerTransportSchema>;
/** 凭据选项及各业务源的实际生效来源。 */
type ManagedSqlServerTransport = z.infer<typeof managedSqlServerTransportSchema>;
/** 连接选项的比较更新输入。 */
type SqlServerTransportUpdate = z.infer<typeof sqlServerTransportUpdateSchema>;
export type { SqlServerTransport, ManagedSqlServerTransport, SqlServerTransportUpdate };
