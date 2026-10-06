import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "../../ai-data/apps/web/node_modules/@playwright/test/index.mjs";

// 从本地正式配置读取登录信息，记录只保留检查结果。
const root = new URL("../../", import.meta.url);
const config = JSON.parse(
  await readFile(
    new URL("ai-data/apps/api/config/api.config.json", root),
    "utf8",
  ),
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const result = {
  date: new Date().toISOString(),
  target: "http://127.0.0.1:5173",
  checks: [],
};
try {
  await page.goto(result.target + "/reports");
  await page
    .getByLabel("用户名", { exact: true })
    .fill(config.bootstrap_admin.username);
  await page
    .getByLabel("密码", { exact: true })
    .fill(config.bootstrap_admin.password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("heading", { name: "报表中心", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".el-skeleton"));
  result.checks.push({ name: "正式配置登录及报表入口", passed: true });
  result.rows = await page.locator(".report-row").count();
  result.empty = await page
    .getByRole("heading", { name: "还没有可查看的报表", exact: true })
    .isVisible();
  result.alerts = await page.getByRole("alert").allTextContents();
  await page.screenshot({
    path: fileURLToPath(new URL("正式报表中心.png", import.meta.url)),
    fullPage: true,
  });
  await page.goto(result.target + "/reports/step5-missing-report");
  await page.getByRole("alert").first().waitFor();
  result.checks.push({
    name: "不存在的报表有明确错误",
    passed: (await page.getByRole("alert").allTextContents()).some((text) =>
      text.includes("不存在"),
    ),
  });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await writeFile(
    new URL("正式只读验收.json", import.meta.url),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
