import { z } from "zod";

/** 管理员维护的业务部门标识集合；空集合撤销全部部门范围。 */
const departmentIdsSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length, "部门标识不能重复");

export { departmentIdsSchema };
