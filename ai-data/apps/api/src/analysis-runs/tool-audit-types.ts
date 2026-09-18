import type { z } from "zod";
import type { toolAuditSchema } from "./tool-audit";
/** 当前租约的一次工具输入摘要和执行结果。 */
type ToolAudit = z.input<typeof toolAuditSchema>;
export type { ToolAudit };
