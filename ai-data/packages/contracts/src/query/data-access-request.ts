import { z } from "zod";
import { queryDslSchema } from "./query-dsl";
import { queryAccessContextSchema } from "../access/access-context";

/**
 * API → Data Access Service 的完整查询请求；仅接受声明字段。
 * 本层校验载荷结构，JWT 与签名真实性由请求验签流程检查。
 */
const dataAccessQueryRequestSchema = z
  .object({
    /** API 签发的审计关联信息、有效期和结果脱敏指令。 */
    access: queryAccessContextSchema,
    /** 由 API 完成业务与权限处理后交付的最终 DSL。 */
    query: queryDslSchema,
    /** API 对 access 和 query 整体生成的防篡改签名。 */
    signature: z.string().min(1),
  })
  .strict();

export { dataAccessQueryRequestSchema };
export { queryAccessContextSchema } from "../access/access-context";
