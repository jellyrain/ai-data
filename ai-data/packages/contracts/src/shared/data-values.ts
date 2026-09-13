import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { z } from "zod";

// 启用按指定格式严格解析，使无效日期（如 2 月 30 日）在合同边界被拒绝。
dayjs.extend(customParseFormat);

/** DAS、API 与 Web 共用的字段和参数类型。 */
const dataTypeSchema = z.enum([
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "buffer",
]);

/** 日期合同：检查 YYYY-MM-DD 格式及日历有效性。 */
const dateSchema = z
  .string()
  .refine((value) => dayjs(value, "YYYY-MM-DD", true).isValid(), "必须是有效的 YYYY-MM-DD 日期");

/** 日期时间合同：检查真实日期和秒级格式；调用方按项目约定使用东八区，本层不转换时区。 */
const dateTimeSchema = z
  .string()
  .refine(
    (value) => dayjs(value, "YYYY-MM-DD HH:mm:ss", true).isValid(),
    "必须是有效的 YYYY-MM-DD HH:mm:ss 日期时间",
  );

/** JSON 中二进制值的 Base64 表示；校验非空、四字符分组及填充字符形式。 */
const base64Schema = z
  .string()
  .refine(
    (value) => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "必须是有效的 Base64 文本",
  );

/** 按声明类型检查查询值；null 作为通用空值放行，字段是否允许为空由调用方另行约束。 */
function isDataValue(value: unknown, dataType: z.infer<typeof dataTypeSchema>): boolean {
  if (value === null) return true;
  switch (dataType) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "decimal":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return dateSchema.safeParse(value).success;
    case "datetime":
      return dateTimeSchema.safeParse(value).success;
    case "buffer":
      return base64Schema.safeParse(value).success;
  }
}

export { base64Schema, dataTypeSchema, dateSchema, dateTimeSchema, isDataValue };
