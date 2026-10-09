import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const directory = fileURLToPath(
  new URL("../../../../../任务交接/问答执行明细与会话管理验收/", import.meta.url),
);
test.use({ video: "off" });
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "分析问题" })).toBeVisible();
}
async function send(page: Page, question: string, completed = true) {
  await page.getByRole("textbox", { name: "分析问题" }).fill(question);
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  if (completed) await expect(page.getByText("分析完成", { exact: true }).last()).toBeVisible();
  else await expect(page.getByRole("button", { name: "停止分析", exact: true })).toBeVisible();
}
async function fresh(page: Page, question: string, completed = true) {
  await page.goto("/analysis");
  await send(page, question, completed);
}

test("工具详情、对应 SQL、两张表中仅导出选定表的全部 5000 行", async ({ page }) => {
  await mkdir(directory, { recursive: true });
  await login(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await send(page, "工具和明细导出验收");
  await send(page, "继续查看第二份科室明细");
  await expect(page.locator(".run-panel")).toHaveCount(2);
  const first = page.locator(".run-panel").first();
  await first.getByRole("button", { name: /查看分析过程/ }).click();
  await first.locator(".tool-record").click();
  const evidence = page.locator(".analysis-evidence .evidence-panel");
  await expect(evidence.locator(".tool-evidence")).toContainText("业务量 · 本年 · 已授权科室");
  await expect(evidence.locator(".tool-evidence")).toContainText("320 ms");
  await evidence.getByRole("tab", { name: /查询依据/ }).click();
  await evidence.getByText("执行 SQL", { exact: true }).click();
  await expect(evidence.locator(".evidence-sql code")).toContainText("SELECT [v].[department]");
  await expect(evidence.locator(".evidence-sql")).toContainText("@p1 · date");
  await first.locator(".tool-record").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/工具详情与SQL.png` });
  await first.locator(".query-results-toggle").click();
  await first.getByRole("button", { name: "导出本表", exact: true }).click();
  await expect(page.getByText("已选 1 张表 · 5,000 行", { exact: true })).toBeVisible();
  await expect(page.locator(".export-tables .el-checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "生成文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载文件", exact: true })).toBeVisible({
    timeout: 60000,
  });
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件", exact: true }).click();
  const download = await downloading;
  const path = `${directory}/科室单表明细.xlsx`;
  await download.saveAs(path);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Uint8Array.from(await readFile(path)).buffer);
  expect(book.worksheets).toHaveLength(2);
  const sheet = book.worksheets.find((item) => item.name !== "导出说明")!;
  expect(sheet.rowCount).toBe(5001);
  expect(sheet.getCell("A5001").value).toBe("科室 5000");
  await page.screenshot({ path: `${directory}/单表导出.png` });
  expect(errors).toEqual([]);
});

test("搜索后全选、部分取消、批量删除当前会话及单个删除", async ({ page }) => {
  await login(page);
  for (const suffix of ["甲", "乙", "丙"]) await fresh(page, `批量管理验收${suffix}`);
  const list = page.locator(".analysis-conversations");
  await list.getByRole("textbox", { name: "筛选会话" }).fill("批量管理验收");
  await list.getByRole("button", { name: "多选", exact: true }).click();
  await list
    .locator("label.el-checkbox")
    .filter({ hasText: /^全选$/ })
    .click();
  await list
    .locator("label.el-checkbox")
    .filter({ has: page.getByRole("checkbox", { name: "选择会话 批量管理验收甲", exact: true }) })
    .click();
  await expect(list.getByRole("button", { name: "删除 2 项", exact: true })).toBeEnabled();
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/多选删除.png` });
  await list.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await page.getByRole("button", { name: "确认删除 2 项", exact: true }).click();
  await expect(page).toHaveURL(/\/analysis$/);
  await expect(list.locator(".conversation-links a")).toHaveCount(1);
  await list.getByRole("button", { name: "完成", exact: true }).click();
  await list.getByRole("button", { name: "删除会话 批量管理验收甲", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(list.locator(".conversation-links a")).toHaveCount(1);
  await list.getByRole("button", { name: "删除会话 批量管理验收甲", exact: true }).click();
  await page.getByRole("button", { name: "确认删除 1 项", exact: true }).click();
  await expect(list.locator(".conversation-links a")).toHaveCount(0);
  await page.reload();
  await list.getByRole("textbox", { name: "筛选会话" }).fill("批量管理验收");
  await expect(list.locator(".conversation-links a")).toHaveCount(0);
});

test("手机多选遇到运行中的会话时整批保留，停止后可删除", async ({ page }) => {
  await login(page);
  await fresh(page, "删除冲突验收已完成");
  await fresh(page, "删除冲突验收慢速查询", false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开最近会话" }).click();
  const list = page.getByRole("dialog", { name: "最近会话", exact: true });
  await list.getByRole("textbox", { name: "筛选会话" }).fill("删除冲突验收");
  await list.getByRole("button", { name: "多选", exact: true }).click();
  await list
    .locator("label.el-checkbox")
    .filter({ hasText: /^全选$/ })
    .click();
  await list.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await page.getByRole("button", { name: "确认删除 2 项", exact: true }).click();
  await expect(list.locator(".inline-error")).toContainText("请先停止");
  await expect(list.locator(".conversation-links a")).toHaveCount(2);
  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/手机删除冲突提示.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "停止分析", exact: true }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开最近会话" }).click();
  await list.getByRole("button", { name: "删除 2 项", exact: true }).click();
  await page.getByRole("button", { name: "确认删除 2 项", exact: true }).click();
  await expect(page).toHaveURL(/\/analysis$/);
});

test("报表分析说明留在报表中心，普通问题不会按标题误判", async ({ page }) => {
  await login(page);
  await send(page, "报表分析说明也是我的普通问题");
  await page.goto("/reports/report-01");
  await page.getByRole("button", { name: "AI 分析", exact: true }).click();
  await page.getByRole("textbox", { name: "分析说明要求" }).fill("分析科室变化");
  await page.getByRole("button", { name: "生成分析说明", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本次报表分析", exact: true })).toBeVisible();
  await page.goto("/analysis");
  const list = page.locator(".analysis-conversations");
  await list.getByRole("textbox", { name: "筛选会话" }).fill("报表分析说明");
  await expect(list.locator(".conversation-links a")).toHaveCount(1);
  await expect(list.locator(".conversation-links a")).toHaveText("报表分析说明也是我的普通问题");
  await page.goto("/reports/report-01");
  await page.getByRole("button", { name: "AI 分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本次报表分析", exact: true })).toBeVisible();
});
