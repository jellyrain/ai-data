import { createHash } from "node:crypto";
import dayjs from "dayjs";
import {
  queryDslSchema,
  stableStringify,
  userPreferenceInputSchema,
  type PreferenceTimeRange,
  type UserPreferenceInput,
} from "@ai-data/contracts";
import { resolvePreferenceTimeRange } from "../preferences/preference-time";

/** 仅从成功的简单查询保存可复用条件，复杂联表和 OR 语义保留在原证据中。 */
function captureQueryHabit(
  input: unknown,
  userText: string,
  now = dayjs().valueOf(),
  metricId?: string,
): UserPreferenceInput | null {
  if (/临时|仅本次|只这次|这次先/.test(userText)) return null;
  const parsed = queryDslSchema.safeParse(input);
  if (!parsed.success) return null;
  const query = parsed.data;
  if (
    query.type !== "relational_query" ||
    query.joins.length ||
    query.from.pre_aggregate ||
    query.from.filters ||
    query.filters.logic !== "and" ||
    query.filters.items.some((item) => "logic" in item)
  )
    return null;
  let filters = query.filters.items.filter(
    (item): item is Exclude<typeof item, { logic: string }> => !("logic" in item),
  );
  let timeRange: PreferenceTimeRange | undefined;
  const period = /本年|今年/.test(userText)
    ? "this_year"
    : /本月|这个月/.test(userText)
      ? "this_month"
      : /本季|本季度/.test(userText)
        ? "this_quarter"
        : /去年|上一年/.test(userText)
          ? "last_year"
          : /上月|上个月/.test(userText)
            ? "last_month"
            : undefined;
  if (period) {
    for (const extent of ["full_period", "to_date"] as const) {
      const range = resolvePreferenceTimeRange({ type: "relative", period, extent }, now);
      const index = filters.findIndex(
        (item) =>
          ["date", "datetime"].includes(item.data_type) &&
          item.op === "between" &&
          Array.isArray(item.value) &&
          item.value[0] === (item.data_type === "date" ? range.start : range.start + " 00:00:00") &&
          item.value[1] === (item.data_type === "date" ? range.end : range.end + " 23:59:59"),
      );
      if (index >= 0) {
        timeRange = { type: "relative", period, extent };
        filters = filters.filter((_, i) => i !== index);
        break;
      }
    }
    if (!timeRange) return null;
  }
  if (!timeRange && !filters.length && !query.group_by.length) return null;
  const scope = {
    source_id: query.source_id,
    object_id: query.from.object_id,
    ...(metricId ? { metric_id: metricId } : {}),
  };
  filters = filters.map((item) => ({ ...item, field: item.field.split(".").at(-1)! }));
  const dimensions = query.group_by.map((field) => field.split(".").at(-1)!);
  const value = {
    type: "query_habit" as const,
    ...(metricId ? { metric_id: metricId } : {}),
    ...(timeRange ? { time_range: timeRange } : {}),
    filters,
    dimensions,
  };
  // 同一业务场景使用稳定键；改变条件触发领域冲突规则，不产生另一份可自动覆盖的默认。
  const key =
    "habit-" +
    createHash("sha256")
      .update(stableStringify({ scope, dimensions: [...dimensions].sort() }))
      .digest("hex");
  const preference = userPreferenceInputSchema.safeParse({ key, scope, value, auto_apply: true });
  return preference.success ? preference.data : null;
}

export { captureQueryHabit };
