import type { z } from "zod";

import type { connectorKindSchema } from "./connector-kind";

/** 运行时可使用的一条数据源配置。 */
type DataSourceConfig = {
  /** 数据源配置标识。 */
  sourceId: string;
  /** 连接器工厂选择依据。 */
  connectorKind: z.infer<typeof connectorKindSchema>;
  /** 加密连接配置引用。 */
  secretRef: string;
  /** SQL Server、MySQL 或 PostgreSQL 的目标数据库；每个 source_id 独立绑定。 */
  targetDatabase?: string;
  /** Oracle 连接目标的标识方式；其他连接器省略。 */
  oracleConnectType?: "sid" | "service_name";
  /** Oracle SID 或 Service Name；每个 source_id 独立绑定。 */
  oracleConnectTarget?: string;
  /** 执行超时上限，单位毫秒。 */
  timeoutMs: number;
  /** 业务数据库连接池最大连接数。 */
  connectionPoolLimit: number;
  /** 单数据源业务请求并发上限。 */
  concurrencyLimit: number;
  /** 最终返回行数上限。 */
  rowLimit: number;
  /** 兼容历史存储的成本字段，不参与并发、排队或执行控制。 */
  costLimit: number;
};

export type { DataSourceConfig };
