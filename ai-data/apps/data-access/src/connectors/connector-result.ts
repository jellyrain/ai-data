import { queryResultColumnSchema } from "@ai-data/contracts";
import { z } from "zod";

/** 数据源连接器完成执行后交给 DAS 的标准化扁平表结果。 */
const connectorExecutionResultSchema = z
  .object({
    /** 已转换为统一类型的返回列定义。 */
    columns: z.array(queryResultColumnSchema),
    /** 已完成字段映射与类型转换的扁平结果行。 */
    rows: z.array(z.record(z.string(), z.unknown())),
    /** 当前响应实际携带的结果行数。 */
    row_count: z.number().int().nonnegative(),
    /** 是否因 DAS 最终行数上限而截断。 */
    truncated: z.boolean(),
    /** 可选的新鲜度文本，仅由连接器可获得的源信息提供。 */
    freshness: z.string().optional(),
  })
  /** 连接器结果不允许泄漏 SQL、URL、连接信息或上游权限字段。 */
  .strict()
  .refine((result) => result.row_count === result.rows.length, {
    message: "row_count 必须等于当前返回的 rows 数量",
  });

/** 连接器完成执行后的已校验统一表格结果类型。 */
type ConnectorExecutionResult = z.infer<typeof connectorExecutionResultSchema>;

export { connectorExecutionResultSchema };

export type { ConnectorExecutionResult };
