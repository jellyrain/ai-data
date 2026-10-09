import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../../../../../任务交接/问答布局与工具依据验收/", import.meta.url),
);
test.use({ video: "off", viewport: { width: 1920, height: 1080 } });
async function start(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "海蓝", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByLabel("分析问题", { exact: true }).fill("布局验收：查询今年门诊人次，科室明细");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
}
test("多份原始结果默认收起，切换单行结果后高度、导出与保存均对应所选表", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  await expect(page.locator(".query-results-toggle")).toHaveText("查看查询数据 · 2 份");
  await expect(page.locator(".result-view")).toHaveCount(0);
  await expect(page.locator(".markdown-table table")).toHaveCount(1);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/桌面默认对话.png` });
  const evidenceResponse = page.waitForResponse((response) =>
    /\/analysis-runs\/[^/]+\/evidence$/.test(response.url()),
  );
  await page.locator(".query-results-toggle").click();
  const evidence = (await (await evidenceResponse).json()).items;
  await expect(page.locator(".query-result-tabs").getByRole("tab")).toHaveCount(2);
  const positions = await page
    .locator('.query-result-tabs [role="tab"]')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().y));
  expect(Math.abs(positions[0]! - positions[1]!)).toBeLessThan(2);
  await expect(page.locator(".result-view")).toHaveCount(1);
  await page.getByRole("tab", { name: "查询 2 · 1 行", exact: true }).click();
  await expect(page.locator(".result-view")).toContainText("10053");
  const height = await page
    .getByTestId("virtual-table")
    .evaluate((element) => element.clientHeight);
  expect(height).toBeLessThan(100);
  await expect(page.locator(".result-view .el-pagination")).toHaveCount(0);
  await page.getByRole("button", { name: "导出本表", exact: true }).click();
  await expect(page.getByText("已选 1 张表 · 1 行", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "保存为报表", exact: true }).click();
  await expect(page.getByText("已选择一份查询结果 · 1 列 · 1 行", { exact: true })).toBeVisible();
  await page.getByLabel("报表名称", { exact: true }).fill("布局验收门诊总计");
  const saving = page.waitForRequest(
    (request) => request.url().endsWith("/api/reports") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "保存报表", exact: true }).click();
  const request = await saving;
  expect(request.postDataJSON().sections[0].blocks[0].evidence_ids).toEqual([
    evidence[1].evidence_id,
  ]);
  await expect(page.getByRole("link", { name: "查看已保存报表" })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".query-results").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/单行查询与操作.png` });
  await page.reload();
  await expect(page.locator(".query-results-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".result-view")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("紧凑工具行分别定位失败和成功详情，查询依据可查看对应 SQL", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: /查看分析过程/ }).click();
  const failed = page.locator(".tool-record.tool-failed");
  await expect(failed).toContainText("查询数据未成功");
  await failed.click();
  const evidence = page.locator(".analysis-evidence .evidence-panel");
  await expect(evidence.locator(".tool-evidence")).toContainText("时间格式不符合 datetime 要求");
  await expect(page.locator(".run-timeline")).not.toContainText("时间格式不符合 datetime 要求");
  const completed = page.locator(".tool-record").last();
  const sizes = await completed.evaluate((element) => ({
    width: element.clientWidth,
    parent: element.parentElement!.clientWidth,
    border: getComputedStyle(element).borderTopWidth,
  }));
  expect(sizes.width).toBeLessThan(sizes.parent * 0.65);
  expect(sizes.border).toBe("0px");
  await completed.click();
  await expect(evidence.locator(".tool-evidence")).toContainText("320 ms");
  await expect(evidence.locator(".related-queries button")).toHaveCount(2);
  await evidence.getByRole("button", { name: "查询 2 · 1 行 · 查看 SQL", exact: true }).click();
  const total = evidence.locator(".evidence-item").nth(1);
  await total.getByText("执行 SQL", { exact: true }).click();
  await expect(total.locator("code")).toContainText("COUNT");
  await completed.click();
  await expect(evidence.locator(".tool-evidence")).toBeVisible();
  await mkdir(directory, { recursive: true });
  await completed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/工具状态与依据.png` });
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
  await expect(page.locator(".appearance-panel")).not.toBeVisible();
  await page.screenshot({ path: `${directory}/工具状态与依据暗色.png`, animations: "disabled" });
});
test("手机工具详情进入抽屉，结果按钮可换行且页面不横向溢出", async ({ page }) => {
  await start(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /查看分析过程/ }).click();
  await page.locator(".tool-record").last().click();
  const drawer = page.getByRole("dialog", { name: "分析依据", exact: true });
  await expect(drawer.getByRole("region", { name: "工具调用详情" })).toContainText("320 ms");
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/手机工具依据.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await page.locator(".query-results-toggle").click();
  await page.getByRole("tab", { name: "查询 2 · 1 行", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存为报表", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator(".query-results")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.locator(".query-results").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/手机查询结果.png` });
});
