import { z } from "zod";
import { queryDslSchema } from "./query-dsl";
import { queryAccessContextSchema } from "../access/access-context";

/** API → Data Access Service 的一次完整查询请求。 */
const dataAccessQueryRequestSchema = z
  .object({
    /** API 签发的审计上下文；查询权限条件已在 query 中生效。 */
    access: queryAccessContextSchema,
    /** API 已完成业务校验、权限计算和过滤条件注入的查询 DSL。 */
    query: queryDslSchema,
    /** API 对 access 和 query 整体生成的防篡改签名。 */
    signature: z.string().min(1),
  })
  .strict();

export { dataAccessQueryRequestSchema };
export { queryAccessContextSchema } from "../access/access-context";
