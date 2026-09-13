import type { z } from "zod";

import type { columnOperationSchema } from "./column-operation";

/** API 字段权限允许控制的操作类型。 */
type ColumnOperation = z.infer<typeof columnOperationSchema>;

export type { ColumnOperation };
