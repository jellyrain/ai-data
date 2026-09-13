import type { z } from "zod";
import type { queryDslSchema } from "./query-dsl";

/** API 传给 Data Access Service 的关系查询与参数化查询联合类型。 */
type QueryDsl = z.infer<typeof queryDslSchema>;

export type { QueryDsl };
