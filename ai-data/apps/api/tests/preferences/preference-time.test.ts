import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { resolvePreferenceTimeRange } from "../../src/preferences/preference-time";

// 前提：保存相对日历语义或固定日期。操作：在不同当前日期解析。预期：东八区相对时间随日历变化，固定日期保持原值。
describe("账号记忆的东八区日期解析", () => {
  it("跨年以东八区为准重新计算本年", () => {
    const range = {
      type: "relative" as const,
      period: "this_year" as const,
      extent: "full_period" as const,
    };
    expect(resolvePreferenceTimeRange(range, dayjs("2026-12-31T15:59:59Z").valueOf())).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
    expect(resolvePreferenceTimeRange(range, dayjs("2026-12-31T16:00:00Z").valueOf())).toEqual({
      start: "2027-01-01",
      end: "2027-12-31",
    });
  });
  it("完整上月含闰日，本季度及截至当日范围按日历解析", () => {
    const now = dayjs("2024-03-20T00:00:00Z").valueOf();
    expect(
      resolvePreferenceTimeRange(
        { type: "relative", period: "last_month", extent: "full_period" },
        now,
      ),
    ).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(
      resolvePreferenceTimeRange(
        { type: "relative", period: "this_quarter", extent: "to_date" },
        now,
      ),
    ).toEqual({ start: "2024-01-01", end: "2024-03-20" });
    expect(
      resolvePreferenceTimeRange(
        { type: "relative", period: "this_month", extent: "full_period" },
        now,
      ),
    ).toEqual({ start: "2024-03-01", end: "2024-03-31" });
    expect(
      resolvePreferenceTimeRange(
        { type: "relative", period: "last_year", extent: "full_period" },
        now,
      ),
    ).toEqual({ start: "2023-01-01", end: "2023-12-31" });
  });
  it("固定年份跨年保持不变", () => {
    expect(
      resolvePreferenceTimeRange(
        { type: "fixed", start: "2025-01-01", end: "2025-12-31" },
        dayjs("2030-04-01").valueOf(),
      ),
    ).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });
});
