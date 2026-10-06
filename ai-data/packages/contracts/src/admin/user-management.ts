import { z } from "zod";

/** 管理主键沿用元数据长度，集合禁止重复，防止重复绑定。 */
const id = z.string().trim().min(1).max(128);
const ids = z
  .array(id)
  .max(1000)
  .refine((values) => new Set(values).size === values.length, "标识不能重复");
/** 用户创建只接受本地账号及初始授权，组织由当前身份提供。 */
const createManagedUserSchema = z
  .object({
    /** 组织内登录名及展示名称。 */
    username: z.string().trim().min(1).max(256),
    display_name: z.string().trim().min(1).max(256),
    /** 仅在创建请求使用的密码，不进入公开响应。 */
    password: z.string().min(8).max(1024),
    /** 省略时创建无角色、无个人例外的用户。 */
    role_ids: ids.default([]),
    exception_data_scope_ids: ids.default([]),
  })
  .strict();
/** 部门范围整体替换，空集合撤回；旧客户端省略基准时沿用最后写入语义。 */
const managedDepartmentsInputSchema = z
  .object({
    department_ids: ids,
    expected_authorization_version: z.number().int().positive().max(2_147_483_646).optional(),
  })
  .strict();
/** 用户列表及详情的公开字段，严格拒绝密码字段。 */
const managedUserSchema = z
  .object({
    id,
    organization_id: id,
    username: z.string().min(1).max(256),
    display_name: z.string().min(1).max(256),
    status: z.enum(["active", "disabled", "pending"]),
    authorization_version: z.number().int().positive(),
  })
  .strict();
/** 角色的既有定义；管理权限由 API 判定为特权角色。 */
const managedRoleSchema = z
  .object({
    id,
    code: id,
    name: z.string().min(1).max(256),
    status: z.string().min(1).max(32),
    is_privileged: z.boolean(),
  })
  .strict();
/** 现有个人强制范围，值保留原存储表达以解释实际绑定。 */
const managedDataScopeSchema = z
  .object({
    id,
    resource: z.string().min(1).max(256),
    field: z.string().min(1).max(256),
    operator: z.enum(["eq", "in"]),
    value: z.string(),
  })
  .strict();
/** 服务端按组织及当前操作者筛选后的可分配选项。 */
const userAssignmentOptionsSchema = z
  .object({
    roles: z.array(managedRoleSchema),
    exception_data_scopes: z.array(managedDataScopeSchema),
    department_ids: z.array(id),
  })
  .strict();
/** 固定用户的当前授权资料，版本用于部门范围比较更新。 */
const managedUserAuthorizationSchema = z
  .object({
    user_id: id,
    authorization_version: z.number().int().positive(),
    roles: z.array(managedRoleSchema),
    exception_data_scopes: z.array(managedDataScopeSchema),
    department_ids: ids,
  })
  .strict();

export {
  createManagedUserSchema,
  managedDepartmentsInputSchema,
  managedUserSchema,
  managedRoleSchema,
  managedDataScopeSchema,
  userAssignmentOptionsSchema,
  managedUserAuthorizationSchema,
};
