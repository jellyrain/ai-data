import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import quarterOfYear from "dayjs/plugin/quarterOfYear";
import { preferenceTimeRangeSchema, type PreferenceTimeRange } from "@ai-data/contracts";

dayjs.extend(utc);
dayjs.extend(quarterOfYear);

/** 东八区日历范围包含首尾日期；历史周期的 to_date 上界仍止于该周期末日。 */
function resolvePreferenceTimeRange(
  input: PreferenceTimeRange,
  now = dayjs().valueOf(),
): { start: string; end: string } {
  const range = preferenceTimeRangeSchema.parse(input);
  if (range.type === "fixed") return { start: range.start, end: range.end };
  const today = dayjs(now).utcOffset(8 * 60);
  const unit = range.period.includes("year")
    ? "year"
    : range.period.includes("quarter")
      ? "quarter"
      : "month";
  const period = range.period.startsWith("last_") ? today.subtract(1, unit) : today;
  const start = period.startOf(unit);
  const end = period.endOf(unit);
  return {
    start: start.format("YYYY-MM-DD"),
    end: (range.extent === "to_date" && today.isBefore(end) ? today : end).format("YYYY-MM-DD"),
  };
}

export { resolvePreferenceTimeRange };
