import { z } from "zod";
import { dataTypeSchema, isDataValue } from "../shared/data-values";

/** 查询结果列的标准化元数据，仅接受声明字段。 */
const queryResultColumnSchema = z
  .object({
    /** 返回列名称或生成后的别名。 */
    name: z.string().min(1),
    /** 标准化后的返回列类型。 */
    data_type: dataTypeSchema,
  })
  .strict();

/** 表格列与行的公共边界；列名唯一，每行恰好包含全部列，并使用对应的 JSON 值类型。 */
const queryResultTableSchema = z
  .object({
    /** 返回列定义。 */
    columns: z.array(queryResultColumnSchema),
    /** 结果行，键为列名，值由连接器标准化。 */
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .strict()
  .superRefine((table, context) => {
    const names = new Set<string>();
    table.columns.forEach((column, index) => {
      if (names.has(column.name))
        context.addIssue({
          code: "custom",
          path: ["columns", index, "name"],
          message: "结果列名必须唯一",
        });
      names.add(column.name);
    });
    table.rows.forEach((row, index) => {
      if (
        Object.keys(row).length !== names.size ||
        Object.keys(row).some((name) => !names.has(name))
      ) {
        context.addIssue({
          code: "custom",
          path: ["rows", index],
          message: "结果行字段必须与列定义一致",
        });
      }
      table.columns.forEach((column) => {
        const value = row[column.name];
        const valid =
          value === null ||
          (column.data_type === "buffer" && value === "") ||
          (column.data_type === "integer"
            ? Number.isSafeInteger(value)
            : isDataValue(value, column.data_type));
        if (!Object.hasOwn(row, column.name) || !valid)
          context.addIssue({
            code: "custom",
            path: ["rows", index, column.name],
            message: "结果值必须符合声明类型",
          });
      });
    });
  });

/** Data Access Service 返回给 API 的标准化查询结果；拒绝未知字段，并校验行数与表格内容。 */
const queryResultSchema = queryResultTableSchema
  .safeExtend({
    /** 当前响应携带的实际行数，必须与 rows 长度相等。 */
    row_count: z.number().int().nonnegative(),
    /** 是否因 limit 或连接器限制截断。 */
    truncated: z.boolean(),
    /** 数据新鲜度说明，可由连接器提供。 */
    freshness: z.string().optional(),
  })
  .refine((result) => result.row_count === result.rows.length, {
    path: ["row_count"],
    message: "row_count 必须等于当前返回的 rows 数量",
  });

export { queryResultColumnSchema, queryResultSchema, queryResultTableSchema };
