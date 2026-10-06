import type { z } from "zod";
import type {
  createManagedUserSchema,
  managedDepartmentsInputSchema,
  managedUserSchema,
  managedRoleSchema,
  managedDataScopeSchema,
  userAssignmentOptionsSchema,
  managedUserAuthorizationSchema,
} from "./user-management";
/** 管理员创建本地账号的已校验输入。 */
type CreateManagedUser = z.infer<typeof createManagedUserSchema>;
/** 部门范围替换及可选并发版本。 */
type ManagedDepartmentsInput = z.infer<typeof managedDepartmentsInputSchema>;
/** 不含密码的用户资料。 */
type ManagedUser = z.infer<typeof managedUserSchema>;
/** 当前角色定义。 */
type ManagedRole = z.infer<typeof managedRoleSchema>;
/** 个人例外强制范围。 */
type ManagedDataScope = z.infer<typeof managedDataScopeSchema>;
/** 已过滤的分配选项。 */
type UserAssignmentOptions = z.infer<typeof userAssignmentOptionsSchema>;
/** 用户当前绑定及版本。 */
type ManagedUserAuthorization = z.infer<typeof managedUserAuthorizationSchema>;
export type {
  CreateManagedUser,
  ManagedDepartmentsInput,
  ManagedUser,
  ManagedRole,
  ManagedDataScope,
  UserAssignmentOptions,
  ManagedUserAuthorization,
};
