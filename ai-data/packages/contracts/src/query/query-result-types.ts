import type { queryResultColumnSchema, queryResultSchema } from "./query-result";
import type { z } from "zod";
/** 查询结果列元数据类型。 */
type QueryResultColumn = z.infer<typeof queryResultColumnSchema>;
/** 标准化查询结果类型。 */
type QueryResult = z.infer<typeof queryResultSchema>;

export type { QueryResult, QueryResultColumn };
