import { shallowReactive } from "vue";
import { themeSchema } from "./theme-schema";
import type { ThemePreference } from "./theme-types";

const themeStorageKey = "ai-data.appearance.v1";
const palettes = [
  { id: "olive", name: "橄榄绿", swatch: "#686c2b" },
  { id: "blue", name: "海蓝", swatch: "#285fb5" },
  { id: "teal", name: "青绿", swatch: "#16796d" },
  { id: "violet", name: "紫罗兰", swatch: "#7650a4" },
] as const;

/** 损坏或过期格式回退到已确认的默认外观。 */
function readTheme(value: string | null): ThemePreference {
  try {
    return themeSchema.parse(JSON.parse(value ?? "null"));
  } catch {
    return { mode: "light", palette: "olive" };
  }
}
/** 明确选择优先于系统；系统变化不覆盖用户指定的模式。 */
function resolveDark(mode: string, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/** 主题独立于身份缓存，在同一浏览器的标签页之间同步。 */
class ThemeController {
  readonly state: ThemePreference;
  private readonly media: MediaQueryList;
  constructor(private readonly browser: Window = window) {
    let saved: string | null = null;
    try {
      saved = browser.localStorage.getItem(themeStorageKey);
    } catch {
      /* 存储不可用时仍可在本页切换。 */
    }
    this.state = shallowReactive(readTheme(saved));
    this.media = browser.matchMedia("(prefers-color-scheme: dark)");
    this.media.addEventListener("change", this.apply);
    browser.addEventListener("storage", this.storageChanged);
    this.apply();
  }
  set(preference: ThemePreference): void {
    Object.assign(this.state, themeSchema.parse(preference));
    this.apply();
    try {
      this.browser.localStorage.setItem(themeStorageKey, JSON.stringify(this.state));
    } catch {
      /* 保留本页选择。 */
    }
  }
  private apply = (): void => {
    const root = this.browser.document.documentElement;
    const dark = resolveDark(this.state.mode, this.media.matches);
    root.classList.toggle("dark", dark);
    root.dataset.palette = this.state.palette;
    root.dataset.mode = this.state.mode;
    root.style.colorScheme = dark ? "dark" : "light";
  };
  private storageChanged = (event: StorageEvent): void => {
    if (event.key !== themeStorageKey && event.key !== null) return;
    Object.assign(this.state, readTheme(event.newValue));
    this.apply();
  };
  dispose(): void {
    this.media.removeEventListener("change", this.apply);
    this.browser.removeEventListener("storage", this.storageChanged);
  }
}

export { readTheme, resolveDark, ThemeController, themeStorageKey, palettes };
