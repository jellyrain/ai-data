import type { z } from "zod";
import type {
  columnPermissionSchema,
  rowConditionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "./permission-policy";

/** 一条表级行过滤条件的类型。 */
type RowCondition = z.infer<typeof rowConditionSchema>;
/** 角色对表或视图读取权限的类型。 */
type TablePermission = z.infer<typeof tablePermissionSchema>;
/** 角色对数据对象行过滤权限的类型。 */
type RowPolicy = z.infer<typeof rowPolicySchema>;
/** 角色对单个字段可见性权限的类型。 */
type ColumnPermission = z.infer<typeof columnPermissionSchema>;

export type { ColumnPermission, RowCondition, RowPolicy, TablePermission };
