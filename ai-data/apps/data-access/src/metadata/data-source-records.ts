import { MAX_QUERY_ROWS } from "@ai-data/contracts";
import { z } from "zod";

import { connectorKindSchema } from "../data-sources/connector-kind";

/** 元数据库数据源配置行，仅接受查询声明的列；按连接器类型检查目标字段组合。 */
const dataSourceConfigRowSchema = z
  .object({
    /** DAS 内部唯一的数据源配置标识。 */
    source_id: z.string().min(1),
    /** 决定 DataSourceManager 创建哪一种业务连接器。 */
    connector_kind: connectorKindSchema,
    /** 指向加密业务连接配置的引用，不保存明文凭据。 */
    secret_ref: z.string().min(1),
    /** 三类常规数据库的目标库名；Oracle 和 HTTP API 记录应为 NULL。 */
    target_database: z.string().min(1).nullable(),
    /** Oracle 使用 SID 或 Service Name；其他连接器记录为 NULL。 */
    oracle_connect_type: z.enum(["sid", "service_name"]).nullable(),
    /** Oracle 连接目标名称；其他连接器记录为 NULL。 */
    oracle_connect_target: z.string().min(1).nullable(),
    /** 管理员停用数据源时不允许它被创建为运行时连接器。 */
    is_enabled: z.boolean(),
    /** 单次业务数据源执行的最终超时上限，单位毫秒。 */
    timeout_ms: z.number().int().min(100).max(120000),
    /** 当前 source_id 的业务数据库连接池最大连接数。 */
    connection_pool_limit: z.number().int().min(1).max(100),
    /** 当前 source_id 同时执行的业务请求上限。 */
    concurrency_limit: z.number().int().min(1).max(1000),
    /** DAS 向调用方返回的最大行数。 */
    row_limit: z.number().int().min(1).max(MAX_QUERY_ROWS),
    /** 历史成本字段，保留读取兼容性；实际资源控制使用超时和并发配置。 */
    cost_limit: z.number().int().positive(),
  })
  .strict()
  /**
   * 常规数据库要求 target_database；Oracle 要求连接方式和目标；HTTP API 省略数据库目标。
   * 不属于当前连接器的目标列必须为 NULL，避免读取含混配置。
   */
  .superRefine((value, context) => {
    if (["sqlserver", "mysql", "postgresql"].includes(value.connector_kind)) {
      if (value.target_database === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_database"],
          message: "数据库连接器必须配置 target_database",
        });
      }
      if (value.oracle_connect_type !== null || value.oracle_connect_target !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "数据库连接器不能配置 Oracle 连接目标",
        });
      }
    }

    if (value.connector_kind === "oracle") {
      if (value.oracle_connect_type === null || value.oracle_connect_target === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Oracle 连接器必须配置 oracle_connect_type 和 oracle_connect_target",
        });
      }
      if (value.target_database !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_database"],
          message: "Oracle 连接器不能配置 target_database",
        });
      }
    }

    if (value.connector_kind === "http_api") {
      if (
        value.target_database !== null ||
        value.oracle_connect_type !== null ||
        value.oracle_connect_target !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "HTTP API 连接器不能配置数据库目标",
        });
      }
    }
  });

export { dataSourceConfigRowSchema };
