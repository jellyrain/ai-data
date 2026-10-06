import { z } from "zod";

/** 登录输入与现有 API 严格字段保持一致。 */
const loginInputSchema = z
  .object({
    username: z.string().trim().min(1, "请输入用户名"),
    password: z.string().min(1, "请输入密码"),
  })
  .strict();
/** 登录与刷新返回的公开用户摘要。 */
const userSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    username: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();
/** 刷新令牌只在接收边界校验，不进入前端状态和持久化。 */
const loginResultSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresIn: z.number().positive(),
    user: userSchema,
  })
  .strict();
/** 后端给出的完整数据策略仅校验接收，Web 不构造可信权限上下文。 */
const dataPolicySchema = z
  .object({
    resource: z.string(),
    field: z.string(),
    operator: z.enum(["eq", "in"]),
    value: z.union([z.string(), z.array(z.string())]),
    mandatory: z.literal(true),
  })
  .strict();
/** 当前登录上下文；可选字段与实际 AuthContext 对齐。 */
const authContextSchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string().min(1),
    sessionId: z.string().min(1),
    roles: z.array(z.string()),
    roleIds: z.array(z.string()).optional(),
    permissions: z.array(z.string()),
    dataPolicies: z.array(dataPolicySchema),
    permissionContext: z
      .object({ department_ids: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  .strict();

export { loginInputSchema, loginResultSchema, authContextSchema, userSchema };
