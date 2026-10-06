import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AppearancePicker from "../../../src/shared/ui/appearance-picker.vue";
import { ThemeController, themeStorageKey } from "../../../src/shared/theme/theme";
import { servicesKey } from "../../../src/app/services-key";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
function fixture() {
  const media = Object.assign(new EventTarget(), { matches: false });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  return { media, theme: new ThemeController() };
}
describe("主题控件与浏览器环境", () => {
  it("按钮有可感知的选择状态并把完整偏好落盘", async () => {
    const { theme } = fixture();
    const wrapper = mount(AppearancePicker, {
      global: {
        provide: { [servicesKey as symbol]: { theme } },
        stubs: { ElPopover: { template: '<div><slot name="reference" /><slot /></div>' } },
      },
    });
    await wrapper.get('button[aria-label="海蓝"]').trigger("click");
    expect(wrapper.get('button[aria-label="海蓝"]').attributes("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem(themeStorageKey)!)).toEqual({
      mode: "light",
      palette: "blue",
    });
    wrapper.unmount();
    theme.dispose();
  });
  it("存储不可用仍能切换，跟随系统响应变化并同步其他标签页", () => {
    const { theme, media } = fixture();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    theme.set({ mode: "system", palette: "teal" });
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: themeStorageKey,
        newValue: JSON.stringify({ mode: "light", palette: "violet" }),
      }),
    );
    expect(document.documentElement.dataset.palette).toBe("violet");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    theme.dispose();
  });
});
