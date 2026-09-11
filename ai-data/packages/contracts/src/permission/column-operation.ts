import { z } from "zod";

/** API 权限策略中可控制的字段操作。 */
const columnOperationSchema = z.enum(["select", "filter", "group", "sort", "join"]);

export { columnOperationSchema };
