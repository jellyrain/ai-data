import { describe, expect, it } from "vitest";
import { memoryTaskConfigSchema } from "../../src/config/memory-task-config";

describe("后台任务独立预算", () => {
  it("默认单并发，时限短于租约且最大尝试次数有限", () => {
    expect(memoryTaskConfigSchema.parse({})).toMatchObject({
      concurrency: 1,
      timeout_ms: 10000,
      lease_ms: 30000,
      max_attempts: 3,
    });
  });
  it("未知设置及不能覆盖执行时限的租约被拒绝", () => {
    expect(memoryTaskConfigSchema.safeParse({ timeout_ms: 10000, lease_ms: 10000 }).success).toBe(
      false,
    );
    expect(memoryTaskConfigSchema.safeParse({ concurrency: 5 }).success).toBe(false);
    expect(memoryTaskConfigSchema.safeParse({ model: "x" }).success).toBe(false);
  });
});
