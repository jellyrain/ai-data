import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  tsconfig: "./tests/tsconfig.playwright.json",
  testDir: "./tests/e2e",
  globalSetup: "./tests/support/e2e-servers.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5317",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
