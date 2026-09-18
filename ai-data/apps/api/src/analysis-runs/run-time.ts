import dayjs, { type ConfigType } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import utc from "dayjs/plugin/utc";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
const businessTimeFormat = "YYYY-MM-DD HH:mm:ss";

/** 持久化业务时间按东八区表达，租约比较使用 UTC 毫秒。 */
function runTime(value?: ConfigType): string {
  return dayjs(value).utcOffset(8).format(businessTimeFormat);
}
/** 严格按 UTC 读取墙钟字段，再减去东八区偏移，保持与部署机器时区无关。 */
function runTimeMilliseconds(value: string): number {
  return dayjs.utc(value, businessTimeFormat, true).subtract(8, "hour").valueOf();
}
export { runTime, runTimeMilliseconds };
