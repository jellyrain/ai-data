import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include:
      process.env.RELEASE_ACCEPTANCE === "1"
        ? ["tests/integration/release.integration.ts"]
        : ["tests/integration/**/*.integration.ts"],
    exclude:
      process.env.RELEASE_ACCEPTANCE === "1" ? [] : ["tests/integration/release.integration.ts"],
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 120000,
    testTimeout: 30000,
  },
});
