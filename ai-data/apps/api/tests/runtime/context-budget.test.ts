import { describe, expect, it } from "vitest";
import { contextBudget } from "../../src/runtime/context-budget";

describe("模型上下文预算", () => {
  it.each([32768, 65536])("服务实际窗口 %i 对应四分之三压缩阈值", (window) => {
    expect(contextBudget({ serviceWindow: window })).toMatchObject({
      contextWindow: window,
      autoCompactTokenLimit: window * 0.75,
      contextWindowSource: "service",
    });
  });
  it("Agent 显式值优先于模型显式值，但不能超过实际服务窗口", () => {
    expect(
      contextBudget({ serviceWindow: 32768, modelWindow: 16384, agentWindow: 65536 }).contextWindow,
    ).toBe(32768);
    expect(
      contextBudget({ serviceWindow: 32768, modelWindow: 65536, agentWindow: 8192 }),
    ).toMatchObject({ contextWindow: 8192, contextWindowSource: "agent" });
  });
  it("探测不可用时采用显式值，完全缺失时报可定位错误", () => {
    expect(contextBudget({ modelWindow: 8192 })).toMatchObject({
      contextWindow: 8192,
      contextWindowSource: "model",
    });
    expect(() => contextBudget({})).toThrow("请配置模型 context_window");
  });
});
