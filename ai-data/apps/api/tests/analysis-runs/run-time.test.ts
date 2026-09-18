import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTime, runTimeMilliseconds } from "../../src/analysis-runs/run-time";

dayjs.extend(utc);
afterEach(() => vi.useRealTimers());

describe("运行时间的东八区转换", () => {
  it.each([
    ["2026-09-13T16:00:00Z", "2026-09-14 00:00:00"],
    ["2026-12-31T16:00:00Z", "2027-01-01 00:00:00"],
    ["2024-02-29T15:59:59Z", "2024-02-29 23:59:59"],
  ])("UTC 时刻 %s 与东八区业务时间互相转换", (instant, wallTime) => {
    const milliseconds = dayjs.utc(instant).valueOf();
    expect(runTime(milliseconds)).toBe(wallTime);
    expect(runTimeMilliseconds(wallTime)).toBe(milliseconds);
  });
  it("默认使用当前时刻，格式保持秒精度", () => {
    vi.useFakeTimers();
    vi.setSystemTime(dayjs.utc("2026-09-13T16:00:00.123Z").toDate());
    expect(runTime()).toBe("2026-09-14 00:00:00");
  });
  it("无效业务日期不能归一成其他日期或时间", () => {
    expect(runTimeMilliseconds("2026-02-30 08:00:00")).toBeNaN();
    expect(runTimeMilliseconds("2026-09-14 24:00:00")).toBeNaN();
  });
});
