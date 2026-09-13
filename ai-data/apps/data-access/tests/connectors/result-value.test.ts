import { describe, expect, it } from "vitest";

import { normalizeResultValue } from "../../src/connectors/result-value";

describe("标准结果日期与转换边界", () => {
  it("纯时间字符串保留源值", () => {
    expect(normalizeResultValue("02:00:00", "string", "at")).toBe("02:00:00");
  });
  it.each([1e20, "1e20", "100000000000000000000", 100000000000000000000n])(
    "decimal 接受能够往返的有限数值 %#",
    (value) => {
      expect(normalizeResultValue(value, "decimal", "amount")).toBe(1e20);
    },
  );
  it("无时区文本与 UTC 编码墙钟日期保留业务时间", () => {
    expect(normalizeResultValue("2026-09-13 00:00:00.123", "datetime", "at")).toBe(
      "2026-09-13 00:00:00",
    );
    expect(
      normalizeResultValue(new Date("2026-09-13T00:00:00Z"), "datetime", "at", "utc_wall"),
    ).toBe("2026-09-13 00:00:00");
    expect(normalizeResultValue(new Date("2026-09-13T00:00:00Z"), "date", "day", "utc_wall")).toBe(
      "2026-09-13",
    );
    expect(
      normalizeResultValue(new Date(2026, 8, 13, 0, 0, 0), "datetime", "at", "local_wall"),
    ).toBe("2026-09-13 00:00:00");
  });

  it("带时区的时间点按东八区处理跨日", () => {
    expect(normalizeResultValue("2026-09-12T23:00:00-05:00", "datetime", "at")).toBe(
      "2026-09-13 12:00:00",
    );
  });

  it.each(["2026-02-30 00:00:00", "2026-02-30T00:00:00Z", "2026-09-13T25:00:00Z", new Date(NaN)])(
    "拒绝无效日期 %#",
    (value) => {
      expect(() => normalizeResultValue(value, "datetime", "at")).toThrow("结果字段 at");
    },
  );

  it.each([
    NaN,
    Infinity,
    "NaN",
    "Infinity",
    "  ",
    "12x",
    true,
    "9007199254740993",
    "0.10000000000000001",
    "1e-1000",
  ])("拒绝无效 decimal 值 %#", (value) => {
    expect(() => normalizeResultValue(value, "decimal", "amount")).toThrow("结果字段 amount");
  });

  it.each([2, "yes", "", Buffer.from([2])])("拒绝无明确布尔语义的值 %#", (value) => {
    expect(() => normalizeResultValue(value, "boolean", "enabled")).toThrow("结果字段 enabled");
  });

  it.each(["AB==", "abc", "%%%="])("拒绝非规范 Base64 %#", (value) => {
    expect(() => normalizeResultValue(value, "buffer", "data")).toThrow("结果字段 data");
  });
});
