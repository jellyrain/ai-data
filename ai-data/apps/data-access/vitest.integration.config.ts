import { defineConfig } from "vitest/config";

// 集成用例由专用命令收集；默认包测试仅收集 *.test.ts，保持开发验证独立于外部数据库。
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.ts"],
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 120000,
    testTimeout: 120000,
  },
});
