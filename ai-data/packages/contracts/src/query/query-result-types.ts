import type { z } from "zod";
import type {
  queryResultColumnSchema,
  queryResultSchema,
  queryResultDeliverySchema,
} from "./query-result";
/** 查询结果列元数据类型。 */
type QueryResultColumn = z.infer<typeof queryResultColumnSchema>;
/** 标准化查询结果类型。 */
type QueryResult = z.infer<typeof queryResultSchema>;
/** 查询响应的完整性及可确认的总行数。 */
type QueryResultDelivery = z.infer<typeof queryResultDeliverySchema>;

export type { QueryResult, QueryResultColumn, QueryResultDelivery };
