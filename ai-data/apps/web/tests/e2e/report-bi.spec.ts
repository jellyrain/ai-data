import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = fileURLToPath(new URL("../../../../../任务交接/一期基础报表验收/", import.meta.url));
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("editor");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
}
async function shot(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
}
test("卡片名称和说明持久化，冲突不会覆盖服务端版本", async ({ page }) => {
  await login(page);
  await page.goto("/reports");
  // 测试通过已加载报告的稳定地址选择卡片，标题可由业务自由修改。
  const target = page
    .locator(".report-card")
    .filter({ has: page.locator('a[href="/reports/report-05"]') });
  await expect(target).toBeVisible();
  await target.getByRole("button").click();
  await page.getByRole("menuitem", { name: "修改名称与说明" }).click();
  await page.getByLabel("报表名称", { exact: true }).fill("长期费用分析");
  await page.getByLabel("简短说明", { exact: true }).fill("按日期和科室复用");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(target).toContainText("长期费用分析");
  await page.reload();
  await expect(target).toContainText("按日期和科室复用");
  expect(await target.locator("canvas, table, .virtual-table").count()).toBe(0);
  await target.getByRole("button").click();
  await page.getByRole("menuitem", { name: "修改名称与说明" }).click();
  await page.getByLabel("报表名称", { exact: true }).fill("冲突不能覆盖");
  let writes = 0;
  await page.route("**/reports/report-05/definition", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++;
    await route.fulfill({ status: 409, json: { code: "CONFLICT", message: "版本已更新" } });
  });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("报表已被更新。请重新读取最新内容后修改名称。")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  expect(writes).toBe(1);
});
test("一期页面 16:9 截图与单结果切换、列选择、编辑预览", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.goto("/reports");
  await expect(page.locator(".report-card")).toHaveCount(20);
  await shot(page, "01-报表中心");
  await page.goto("/reports/report-01");
  await expect(page.locator(".report-block")).toHaveCount(1);
  await page.getByRole("combobox", { name: "报表内容", exact: true }).press("Enter");
  await page.getByRole("option", { name: "科室分布", exact: true }).click();
  await expect(page.locator(".result-chart canvas")).toBeVisible();
  await shot(page, "02-单图表详情");
  await page.getByRole("button", { name: "查看表格", exact: true }).click();
  await expect(page.locator(".virtual-table")).toBeVisible();
  await page.getByRole("button", { name: "显示列", exact: true }).click();
  await page
    .locator(".el-popover:visible .el-checkbox")
    .filter({ hasText: /^count$/ })
    .click();
  await expect(page.locator(".el-table-v2__header-cell").filter({ hasText: "count" })).toHaveCount(
    0,
  );
  await page
    .locator(".el-popover:visible .el-checkbox")
    .filter({ hasText: /^count$/ })
    .click();
  await page.getByRole("button", { name: "显示列", exact: true }).click();
  await shot(page, "03-明细表详情");
  await page.getByRole("button", { name: "分享", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "报表分享" })).toBeVisible();
  await shot(page, "08-分享设置");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Excel/ })).toBeVisible();
  await shot(page, "09-导出文件");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "结果历史", exact: true }).click();
  await shot(page, "10-结果历史");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "提交为组织模板", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "提交组织模板" })).toBeVisible();
  await shot(page, "12-组织模板");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "编辑报表", exact: true }).click();
  await expect(page.getByText(/使用上次保存结果/)).toBeVisible();
  await shot(page, "05-数据与展示");
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  await shot(page, "04-筛选条件");
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  await expect(page.locator(".query-node").first()).toBeVisible();
  await page.getByRole("button", { name: "打开查询属性", exact: true }).click();
  await shot(page, "06-数据编排");
  await page.getByRole("button", { name: "数据与展示", exact: true }).click();
  await page.getByRole("button", { name: "AI 修改", exact: true }).click();
  await page.getByLabel("AI 修改要求", { exact: true }).fill("将报表改名为门诊趋势分析");
  await shot(page, "07-AI修改");
  await page.getByRole("button", { name: "收起 AI 修改", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "13-手机编辑");
  expect(errors).toEqual([]);
});
test("对话中只保存所选结果，提交失败保留输入并可重试", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page);
  await page.getByLabel("分析问题").fill("需要澄清的门诊分析");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await page.getByRole("button", { name: "本年", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await page.locator(".query-results-toggle").click();
  await page.getByRole("button", { name: "保存为报表", exact: true }).click();
  await page.getByLabel("报表名称", { exact: true }).fill("门诊趋势分析");
  await page.getByLabel("简短说明", { exact: true }).fill("按科室查看门诊人数");
  await shot(page, "11-从对话保存报表");
  const bodies: { sections: { blocks: { evidence_ids: string[] }[] }[] }[] = [];
  await page.route("**/api/reports", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 403,
      json: { code: "POLICY_REJECTED", message: "当前无权保存此结果" },
    });
  });
  await page.getByRole("button", { name: "保存报表", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("当前无权保存此结果");
  await expect(page.getByLabel("报表名称", { exact: true })).toHaveValue("门诊趋势分析");
  expect(bodies[0]!.sections).toHaveLength(1);
  expect(bodies[0]!.sections[0]!.blocks[0]!.evidence_ids).toHaveLength(1);
});
