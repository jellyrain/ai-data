import { z } from "zod";

/** SQL JSON 外壳先校验，再交由共享合同校验内部业务结构。 */
const catalogJsonRowsSchema = z.array(z.object({ config_json: z.string() }).strict());
/** 当前配置版本 0 表示尚未保存，仅用于调用方预期版本比较。 */
const catalogVersionRowsSchema = z.array(
  z.object({ version: z.number().int().positive() }).strict(),
);
/** 关系独立记录的 JSON 列是唯一业务结构来源。 */
const relationJsonRowsSchema = z.array(z.object({ record_json: z.string() }).strict());

export { catalogJsonRowsSchema, catalogVersionRowsSchema, relationJsonRowsSchema };
