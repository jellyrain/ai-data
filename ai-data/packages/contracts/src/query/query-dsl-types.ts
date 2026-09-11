import type { z } from "zod";
import type { queryDslSchema } from "./query-dsl";

/** API 传给 Data Access Service 的关系查询 DSL 类型。 */
type QueryDsl = z.infer<typeof queryDslSchema>;

export type { QueryDsl };
