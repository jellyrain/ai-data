import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAnalysisRuntime } from "../../src/runtime/create-analysis-runtime";

const state = vi.hoisted(() => ({
  config: {} as { stateDirectory?: string },
  order: [] as string[],
  start: vi.fn(async () => {}),
}));
vi.mock("../../src/harness/codex-analysis-harness", () => ({
  CodexAnalysisHarness: class {
    constructor(options: typeof state.config) {
      state.config = options;
    }
    async start() {
      state.order.push("harness-start");
      await state.start();
    }
    async close() {
      state.order.push("harness-close");
    }
  },
}));
vi.mock("../../src/runtime/analysis-dispatcher", () => ({
  PollingAnalysisDispatcher: class {
    start() {
      state.order.push("dispatcher-start");
    }
    async close() {
      state.order.push("dispatcher-close");
    }
  },
}));
beforeEach(() => {
  state.order.length = 0;
  state.start.mockReset();
});
function setup() {
  const startupDirectory = resolve("secrets", "deployment-root");
  const runtime = createAnalysisRuntime({
    config: {
      providers: [{ id: "local", model: "configured", base_url: "http://127.0.0.1/v1" }],
      active_provider: "local",
      state_directory: "runtime",
    },
    startupDirectory,
    skillsDirectory: fileURLToPath(new URL("../../../../packages/skills", import.meta.url)),
  } as Parameters<typeof createAnalysisRuntime>[0]);
  return { runtime, startupDirectory };
}
describe("分析运行时生命周期", () => {
  it("状态根目录相对于项目启动目录，官方进程就绪后才派发", async () => {
    const h = setup();
    expect(state.config.stateDirectory).toBe(resolve(h.startupDirectory, "runtime"));
    await h.runtime.start();
    expect(state.order).toEqual(["harness-start", "dispatcher-start"]);
    await Promise.all([h.runtime.close(), h.runtime.close()]);
    expect(state.order.slice(2)).toEqual(["dispatcher-close", "harness-close"]);
  });
  it("初始化失败时关闭已创建资源并保留失败", async () => {
    const h = setup();
    state.start.mockRejectedValue(new Error("初始化失败"));
    await expect(h.runtime.start()).rejects.toThrow("初始化失败");
    expect(state.order).toEqual(["harness-start", "dispatcher-close", "harness-close"]);
  });
});
