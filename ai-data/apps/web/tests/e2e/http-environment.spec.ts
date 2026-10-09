import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { stableStringify } from "@ai-data/contracts";
import { knowledgeFixture } from "../support/knowledge-fixture";

const directory = fileURLToPath(
  new URL("../../../../../任务交接/Web摘要兼容与连接状态验收/", import.meta.url),
);
test.use({ baseURL: "http://ai-data-http.test:5317", video: "off" });

async function httpSource(page: Page) {
  await page.context().route("http://ai-data-http.test:5317/**", (route) =>
    route.continue({
      url: route.request().url().replace("http://ai-data-http.test:5317", "http://127.0.0.1:5317"),
    }),
  );
}

async function login(page: Page, path = "/analysis", username = "analyst") {
  await page.goto(path);
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === path);
}

function luminance(color: string) {
  const channels = color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map((channel) => {
      const value = Number(channel) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

test("HTTP 缺少 SubtleCrypto 时导出完整五千行 Excel", async ({ page }) => {
  test.setTimeout(60000);
  await httpSource(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  expect(await page.evaluate(() => [window.isSecureContext, typeof crypto.subtle])).toEqual([
    false,
    "undefined",
  ]);
  await page.getByRole("textbox", { name: "分析问题" }).fill("HTTP 导出验收：科室明细");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await page.locator(".query-results-toggle").click();
  await page.getByRole("button", { name: "导出本表", exact: true }).click();
  await expect(page.getByText("已选 1 张表 · 5,000 行", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "生成文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载文件", exact: true })).toBeVisible({
    timeout: 45000,
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  const download = await downloading;
  await mkdir(directory, { recursive: true });
  const path = `${directory}/HTTP科室明细.xlsx`;
  await download.saveAs(path);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Uint8Array.from(await readFile(path)).buffer);
  const sheet = book.worksheets.find((value) => value.name !== "导出说明")!;
  expect(sheet.rowCount).toBe(5001);
  expect(sheet.getCell("A5001").value).toBe("科室 5000");
  expect(errors).toEqual([]);
});

test("HTTP 模板提交的定义摘要与服务端 SHA-256 一致", async ({ page }) => {
  await httpSource(page);
  const fixture = await knowledgeFixture(page);
  await login(page, "/reports/report-01", "admin");
  expect(await page.evaluate(() => typeof crypto.subtle)).toBe("undefined");
  await page.getByRole("button", { name: "提交为组织模板", exact: true }).click();
  await page.getByRole("button", { name: "确认提交模板", exact: true }).click();
  await expect(page.getByRole("link", { name: "查看模板候选", exact: true })).toBeVisible();
  expect(fixture.candidates[0]?.content).toMatchObject({
    type: "report_template",
    definition_version: 2,
    definition_hash: createHash("sha256")
      .update(stableStringify(fixture.template.definition))
      .digest("hex"),
  });
});

test("连接提示位于左下角用户区，支持键盘、明暗主题和手机导航", async ({ page }) => {
  await httpSource(page);
  await login(page, "/analysis", "admin");
  await mkdir(directory, { recursive: true });
  const footer = page.locator(".desktop-sidebar .sidebar-footer");
  const status = footer.getByRole("button", { name: "连接环境：HTTP 未加密", exact: true });
  await expect(status).toBeInViewport();
  const box = await status.boundingBox();
  expect(box!.x).toBeLessThan(220);
  expect(box!.y).toBeGreaterThan(850);
  await status.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "连接环境说明" })).toContainText("非安全上下文");
  await page.screenshot({ path: `${directory}/桌面HTTP连接说明.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(status).toHaveAttribute("aria-expanded", "false");
  for (const mode of ["亮色", "暗色"]) {
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    await expect(page.locator(".appearance-panel")).not.toBeVisible();
    const colors = await status.evaluate((element) => ({
      text: getComputedStyle(element).color,
      background: getComputedStyle(element.closest(".desktop-sidebar")!).backgroundColor,
    }));
    const values = [luminance(colors.text), luminance(colors.background)].sort((a, b) => a - b);
    expect((values[1]! + 0.05) / (values[0]! + 0.05)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({
      path: `${directory}/桌面连接状态-${mode}.png`,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "工作空间导航", exact: true });
  await expect(
    drawer.getByRole("button", { name: "连接环境：HTTP 未加密", exact: true }),
  ).toBeInViewport();
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
  await page.screenshot({ path: `${directory}/手机导航连接状态.png`, animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("本机 HTTP 的提示保留未加密事实", async ({ page }) => {
  await page.goto("http://127.0.0.1:5317/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  const status = page.getByRole("button", { name: "连接环境：本机 HTTP", exact: true });
  await status.click();
  await expect(page.getByRole("region", { name: "连接环境说明" })).toContainText(
    "未使用 HTTPS 加密",
  );
});
