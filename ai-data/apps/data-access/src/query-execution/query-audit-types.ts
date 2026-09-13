import type { z } from "zod";

import type { queryAuditEntrySchema } from "./query-audit";

/** 审计写入前通过应用边界校验的事件类型。 */
type QueryAuditEntry = z.infer<typeof queryAuditEntrySchema>;

export type { QueryAuditEntry };
