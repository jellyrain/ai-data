import { z } from "zod";

/** 查询条件允许使用的比较操作。 */
const queryOperatorSchema = z.enum(["eq", "neq", "in", "not_in", "between", "is_null", "not_null"]);

export { queryOperatorSchema };
