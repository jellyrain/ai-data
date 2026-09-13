import type { z } from "zod";
import type { dataAccessQueryRequestSchema } from "./data-access-request";
import type { QueryAccessContext } from "../access/access-context-types";

/** API → Data Access Service 完整查询请求类型。 */
type DataAccessQueryRequest = z.infer<typeof dataAccessQueryRequestSchema>;

export type { DataAccessQueryRequest, QueryAccessContext };
