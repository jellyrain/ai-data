import { z } from "zod";

/** 普通用户源列表采用有界分页，游标是上一页末尾的源标识；拒绝身份等未知输入。 */
const sourceListInputSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();
/** 只公开当前可查询的源标识；连接和实例信息不进入此响应。 */
const sourceListSchema = z
  .object({
    items: z.array(z.object({ source_id: z.string().min(1).max(128) }).strict()).max(100),
    next_cursor: z.string().min(1).max(128).optional(),
  })
  .strict();
export { sourceListInputSchema, sourceListSchema };
