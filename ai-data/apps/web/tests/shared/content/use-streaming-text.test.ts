import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { useStreamingText } from "../../../src/shared/content/use-streaming-text";
import MarkdownContent from "../../../src/shared/content/markdown-content.vue";

describe("逐字显示", () => {
  const wrappers: ReturnType<typeof mount>[] = [];
  let motion: EventTarget & { matches: boolean };
  function create(text = "", streaming = true) {
    const source = ref(text);
    const active = ref(streaming);
    const wrapper = mount(
      defineComponent({
        setup() {
          const visible = useStreamingText(
            () => source.value,
            () => active.value,
          );
          return () => h("p", visible.value);
        },
      }),
    );
    wrappers.push(wrapper);
    return { source, active, wrapper };
  }
  async function advance(ms = 16) {
    await vi.advanceTimersByTimeAsync(ms);
    await nextTick();
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    motion = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => motion);
  });
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("第一批文字逐字出现，追加内容延续已有文字", async () => {
    const { source, wrapper } = create("我先核对数据");
    expect(wrapper.text()).toBe("");
    await advance();
    expect(wrapper.text()).toBe("我");
    await advance();
    expect(wrapper.text()).toBe("我先");
    source.value += "。";
    await nextTick();
    expect(wrapper.text()).toBe("我先");
    await advance(200);
    expect(wrapper.text()).toBe(source.value);
  });
  it("大批和持续输入在短时间内追上，队列不会累积数秒", async () => {
    const { source, wrapper } = create("字".repeat(2000));
    await advance();
    expect(wrapper.text().length).toBeGreaterThan(0);
    expect(wrapper.text().length).toBeLessThan(2000);
    for (let index = 0; index < 10; index++) {
      source.value += "新".repeat(120);
      await nextTick();
      await advance(64);
      expect(source.value.length - wrapper.text().length).toBeLessThan(2000);
    }
    await advance(220);
    expect(wrapper.text()).toBe(source.value);
  });
  it("完整显示中文、组合字符与表情", async () => {
    const { wrapper } = create("你👩‍💻e\u0301好");
    const prefixes = ["你", "你👩‍💻", "你👩‍💻e\u0301", "你👩‍💻e\u0301好"];
    for (const prefix of prefixes) {
      await advance();
      expect(wrapper.text()).toBe(prefix);
    }
  });
  it("完成和停止立即显示已收到的正文，后续帧不再修改", async () => {
    const { source, active, wrapper } = create("需要显示的正文".repeat(200));
    await advance();
    active.value = false;
    await nextTick();
    expect(wrapper.text()).toBe(source.value);
    expect(vi.getTimerCount()).toBe(0);
    await advance(500);
    expect(wrapper.text()).toBe(source.value);
  });
  it("历史正文和权威替换立即显示，不混入旧队列", async () => {
    const history = create("历史正文", false);
    expect(history.wrapper.text()).toBe("历史正文");
    const current = create("旧正文内容");
    await advance();
    current.source.value = "更正后的正文";
    await nextTick();
    expect(current.wrapper.text()).toBe("更正后的正文");
    await advance(300);
    expect(current.wrapper.text()).toBe("更正后的正文");
  });
  it("减少动态效果时直接显示，并响应偏好切换", async () => {
    motion.matches = true;
    const { source, wrapper } = create("减少动态效果");
    expect(wrapper.text()).toBe(source.value);
    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    source.value += "，继续流式。";
    await nextTick();
    await advance();
    expect(wrapper.text()).not.toBe(source.value);
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    await nextTick();
    expect(wrapper.text()).toBe(source.value);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("切到后台立即同步正文，卸载时取消待显示文字", async () => {
    const { source, wrapper } = create("正在显示的正文");
    await advance();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTick();
    expect(wrapper.text()).toBe(source.value);
    source.value += "，后台新增文字。";
    await nextTick();
    expect(wrapper.text()).toBe(source.value);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const current = create("卸载后不再更新");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    current.wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("Markdown 组件逐字渲染，完成后保留代码块和安全清洗", async () => {
    const wrapper = mount(MarkdownContent, { props: { text: "逐字回复", streaming: true } });
    wrappers.push(wrapper);
    await advance();
    expect(wrapper.find(".markdown-body").text()).toBe("逐");
    await wrapper.setProps({
      text: "```sql\nSELECT '<script>alert(1)</script>';",
      streaming: false,
    });
    expect(wrapper.find("code").text()).toContain("SELECT '<script>alert(1)</script>';");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.find("button[data-copy-index]").exists()).toBe(true);
  });
});
