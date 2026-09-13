import { dateSchema, dateTimeSchema, isDataValue } from "@ai-data/contracts";
import type { ResultDataType, ResultDateMode } from "./result-value-types";

/** 按列声明转换外部值；失败信息只包含字段及目标类型，避免回显业务数据。 */
function normalizeResultValue(
  value: unknown,
  dataType: ResultDataType,
  name: string,
  dateMode: ResultDateMode = "instant",
): string | number | boolean | null {
  if (value === null) return null;
  let result: unknown = value;
  switch (dataType) {
    case "integer":
    case "decimal":
      if (
        typeof value === "bigint" ||
        (typeof value === "string" &&
          (dataType === "integer"
            ? /^[+-]?\d+$/
            : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
          ).test(value))
      )
        result = Number(value);
      if (
        typeof result !== "number" ||
        !Number.isFinite(result) ||
        (dataType === "integer" && !Number.isSafeInteger(result))
      )
        break;
      if (
        (typeof value === "string" || typeof value === "bigint") &&
        canonicalDecimal(String(value)) !== canonicalDecimal(String(result))
      )
        break;
      return result;
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === 1 || value === "1" || value === "true") return true;
      if (value === 0 || value === "0" || value === "false") return false;
      if (Buffer.isBuffer(value) && value.length === 1 && (value[0] === 0 || value[0] === 1))
        return value[0] === 1;
      break;
    case "date":
    case "datetime":
      if (value instanceof Date && Number.isFinite(value.getTime())) {
        result = formatDate(value, dateMode);
        if (dataType === "date") result = (result as string).slice(0, 10);
      } else if (typeof value === "string" && dataType === "datetime") {
        // 无时区时间保持业务墙钟值；有显式时区的 ISO 时间转换为东八区。
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))
          result = value.slice(0, 19).replace("T", " ");
        else if (
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
          dateTimeSchema.safeParse(value.slice(0, 19).replace("T", " ")).success
        ) {
          const date = new Date(value);
          if (Number.isFinite(date.getTime())) result = formatDate(date, "instant");
        }
      }
      if ((dataType === "date" ? dateSchema : dateTimeSchema).safeParse(result).success)
        return result as string;
      break;
    case "buffer":
      if (Buffer.isBuffer(value)) return value.toString("base64");
      if (
        typeof value === "string" &&
        (value === "" ||
          (isDataValue(value, "buffer") &&
            Buffer.from(value, "base64").toString("base64") === value))
      )
        return value;
      break;
    case "string":
      if (typeof value === "string") return value;
      if (
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean" ||
        typeof value === "bigint"
      )
        return String(value);
      if (value instanceof Date && Number.isFinite(value.getTime()))
        return formatDate(value, dateMode);
      if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
        try {
          const json = JSON.stringify(value);
          if (json !== undefined) return json;
        } catch {
          /* 循环或不支持的对象由统一转换错误拒绝。 */
        }
      }
  }
  throw new Error(`结果字段 ${name} 无法转换为 ${dataType}`);
}

/** 比较十进制有效数字和指数，拒绝文本转 number 时发生的舍入或下溢。 */
function canonicalDecimal(value: string): string {
  const [mantissa = "", exponent = "0"] = value.toLowerCase().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const unsigned = mantissa.replace(/^[+-]/, "");
  const [integer = "", fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  return `${sign}${significant}e${Number(exponent) - fraction.length + digits.length - significant.length}`;
}

/** 日期格式化显式选择墙钟字段或东八区偏移，结果与进程默认时区无关。 */
function formatDate(date: Date, mode: ResultDateMode): string {
  const current = mode === "instant" ? new Date(date.getTime() + 8 * 60 * 60 * 1000) : date;
  const parts =
    mode === "local_wall"
      ? [
          current.getFullYear(),
          current.getMonth() + 1,
          current.getDate(),
          current.getHours(),
          current.getMinutes(),
          current.getSeconds(),
        ]
      : [
          current.getUTCFullYear(),
          current.getUTCMonth() + 1,
          current.getUTCDate(),
          current.getUTCHours(),
          current.getUTCMinutes(),
          current.getUTCSeconds(),
        ];
  const [year, month, day, hour, minute, second] = parts.map((part, index) =>
    String(part).padStart(index === 0 ? 4 : 2, "0"),
  );
  if (mode === "utc_time") return `${hour}:${minute}:${second}`;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export { normalizeResultValue };
