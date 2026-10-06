import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第7步验收/", import.meta.url));
test("旧快照按快照版本导出，截断会话只允许文字文档", async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  const paths: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("export-content")) paths.push(request.url());
  });
  await page.goto("/reports/report-02");
  await expect(page.locator(".report-result-heading h2")).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("已选 2 张表 · 12 行", { exact: true })).toBeVisible();
  await file(page, "Excel", `${evidence}/历史快照.xlsx`);
  expect(paths.every((path) => path.endsWith("/reports/report-02/export-content?version=1"))).toBe(
    true,
  );
  await page.goto("/analysis");
  await page.getByRole("textbox", { name: "分析问题" }).fill("截断分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("已选 0 张表 · 0 行", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成文件", exact: true })).toBeDisabled();
  await file(page, "Word", `${evidence}/截断会话说明.docx`);
  const xml = strFromU8(
    unzipSync(await readFile(`${evidence}/截断会话说明.docx`))["word/document.xml"]!,
  );
  expect(xml).toContain("截断，排除明细");
  expect(xml).not.toContain("<w:tbl>");
});
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();
}
async function settledDrawer(page: Page) {
  await expect
    .poll(() =>
      page.locator(".el-drawer:visible").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= innerWidth + 1 && Math.abs(rect.top) < 1;
      }),
    )
    .toBe(true);
}
async function file(page: Page, format: string, path: string) {
  await page
    .locator(".export-format-options .el-radio")
    .filter({ hasText: new RegExp(`^${format}`) })
    .click();
  await page.getByRole("button", { name: "生成文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载文件", exact: true })).toBeVisible({
    timeout: 60000,
  });
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  await (await waiting).saveAs(path);
}
test("5,000 行结果导出全部行，不受展示分页影响", async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  await page.goto("/reports/report-04");
  await expect(page.getByText("已显示 5,000 行", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("已选 1 张表 · 5,000 行", { exact: true })).toBeVisible();
  const path = `${evidence}/完整5000行.xlsx`;
  await file(page, "Excel", path);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Uint8Array.from(await readFile(path)).buffer);
  const sheet = book.worksheets[1]!;
  expect(sheet.rowCount).toBe(5001);
  expect(sheet.getCell("A5001").value).toBe("科室 5000");
  expect(sheet.getCell("B5001").value).toBe(200000);
});
test("会话澄清与结论导出 Word，流程图变为图片，等待运行时禁用入口", async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  await page.getByRole("textbox", { name: "分析问题" }).fill("需要澄清的门诊分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("heading", { name: "补充分析条件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "本年", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const path = `${evidence}/分析会话.docx`;
  await file(page, "Word", path);
  const zip = unzipSync(await readFile(path)),
    xml = strFromU8(zip["word/document.xml"]!);
  expect(xml).toContain("需要澄清的门诊分析");
  expect(xml).toContain("本年");
  expect(xml).toContain("门诊分析结论");
  expect(xml).toContain("100 / 5000");
  expect(Object.keys(zip).some((key) => key.startsWith("word/media/"))).toBe(true);
});
test("分享和导出在八种主题、1024 与390宽度支持键盘，页面不横向溢出", async ({ page }) => {
  test.setTimeout(120000);
  await login(page);
  for (const mode of ["light", "dark"])
    for (const palette of ["olive", "blue", "teal", "violet"]) {
      await page.evaluate(
        (value) => localStorage.setItem("ai-data.appearance.v1", JSON.stringify(value)),
        { mode, palette },
      );
      await page.goto("/reports/report-01");
      await expect(page.getByRole("heading", { name: "门诊人次", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "分享", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("checkbox")).toHaveCount(20);
      await settledDrawer(page);
      await page.screenshot({ path: `${evidence}/分享-${mode}-${palette}.png` });
      await page.keyboard.press("Escape");
      await expect(page.locator(".sharing-content")).not.toBeVisible();
      await page.getByRole("button", { name: "导出", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("radiogroup", { name: "文件格式" })).toBeVisible();
      await settledDrawer(page);
      await page.screenshot({ path: `${evidence}/导出-${mode}-${palette}.png` });
      await page.keyboard.press("Escape");
      await expect(page.locator(".export-options")).not.toBeVisible();
    }
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await expect(page.getByRole("radiogroup", { name: "文件格式" })).toBeVisible();
    await settledDrawer(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${evidence}/导出-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(page.locator(".export-options")).not.toBeVisible();
    await page.getByRole("button", { name: "分享", exact: true }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(20);
    await settledDrawer(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${evidence}/分享-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(page.locator(".sharing-content")).not.toBeVisible();
  }
});
