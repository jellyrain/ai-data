import { z } from "zod";

/** 角色归属查询返回的有效角色和功能权限；LEFT JOIN 的空权限表示尚未配置。 */
const roleAuthorizationRowsSchema = z.array(
  z
    .object({
      role_id: z.string().min(1),
      role_code: z.string().min(1),
      permission_code: z.string().min(1).nullable(),
    })
    .strict(),
);
/** 角色数据范围沿用认证仓储的固定值与逗号分隔 in 语义。 */
const roleScopeRowsSchema = z.array(
  z
    .object({
      resource: z.string().min(1),
      field: z.string().min(1),
      operator: z.enum(["eq", "in"]),
      value: z.string().min(1),
    })
    .strict(),
);
/** 一个不可变版本的持久化 JSON 外壳；内层再按领域版本合同校验。 */
const policyVersionRowSchema = z.object({ record_json: z.string().min(1) }).strict();
/** 源级版本读取结果；无历史时由仓储转换为初始版本 0。 */
const sourceRevisionRowSchema = z.object({ version: z.number().int().positive() }).strict();

export {
  policyVersionRowSchema,
  roleAuthorizationRowsSchema,
  roleScopeRowsSchema,
  sourceRevisionRowSchema,
};
