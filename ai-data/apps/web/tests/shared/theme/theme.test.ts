import { describe, expect, it } from "vitest";
import { readTheme, resolveDark } from "../../../src/shared/theme/theme";

describe("浏览器主题偏好", () => {
  it("首次打开和损坏存储回退到亮色橄榄绿", () => {
    for (const value of [null, "bad-json", '{"mode":"other","palette":"blue"}', "null"])
      expect(readTheme(value)).toEqual({ mode: "light", palette: "olive" });
  });
  it("恢复四套配色和三种模式", () => {
    for (const mode of ["light", "dark", "system"])
      for (const palette of ["olive", "blue", "teal", "violet"])
        expect(readTheme(JSON.stringify({ mode, palette }))).toEqual({ mode, palette });
  });
  it("系统变化仅影响跟随系统模式", () => {
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });
});
