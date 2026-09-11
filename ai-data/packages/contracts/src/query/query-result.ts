import { z } from "zod";
import { dataTypeSchema } from "../shared/data-values";

/** 查询结果列的标准化元数据。 */
const queryResultColumnSchema = z
  .object({
    /** 返回列名称或生成后的别名。 */
    name: z.string().min(1),
    /** 标准化后的返回列类型。 */
    data_type: dataTypeSchema,
  })
  /** 禁止列元数据出现未定义字段。 */
  .strict();

/** Data Access Service 返回给 API 的标准化查询结果。 */
const queryResultSchema = z
  .object({
    /** 返回列定义。 */
    columns: z.array(queryResultColumnSchema),
    /** 结果行，键为列名，值由连接器标准化。 */
    rows: z.array(z.record(z.string(), z.unknown())),
    /** 实际返回行数。 */
    row_count: z.number().int().nonnegative(),
    /** 是否因 limit 或连接器限制截断。 */
    truncated: z.boolean(),
    /** 数据新鲜度说明，可由连接器提供。 */
    freshness: z.string().optional(),
  })
  /** 禁止查询结果出现未定义字段。 */
  .strict();

export { queryResultColumnSchema, queryResultSchema };
