import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { z } from "zod";

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

/** 标准日期文本。 */
const dateSchema = z
  .string()
  .refine((value) => dayjs(value, "YYYY-MM-DD", true).isValid(), "必须是有效的 YYYY-MM-DD 日期");

/** 标准日期时间文本。 */
const dateTimeSchema = z
  .string()
  .refine(
    (value) => dayjs(value, "YYYY-MM-DD HH:mm:ss", true).isValid(),
    "必须是有效的 YYYY-MM-DD HH:mm:ss 日期时间",
  );

/** JSON 传输二进制数据使用的 Base64 文本。 */
const base64Schema = z
  .string()
  .refine(
    (value) => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "必须是有效的 Base64 文本",
  );

/** 校验一个 JSON 值是否符合声明的数据类型。 */
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
