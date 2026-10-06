import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("editor");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
}

test("条件列表切换、默认值预览和增删在独立属性面板中保持同步", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page);
  await page.goto("/reports/report-14/edit");
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  const inspector = page.getByRole("region", { name: "条件属性" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByLabel("参数名称1", { exact: true })).toHaveValue("最少人次");
  await inspector.getByLabel("最少人次默认值", { exact: true }).fill("25");
  await inspector.getByLabel("最少人次默认值", { exact: true }).press("Tab");
  await expect(
    page.locator(".parameter-preview").getByLabel("最少人次", { exact: true }),
  ).toHaveValue("25");
  await page.getByRole("button", { name: "编辑条件：包含停用", exact: true }).click();
  await expect(inspector.getByLabel("参数名称2", { exact: true })).toHaveValue("包含停用");
  await expect(inspector.getByLabel("参数名称1", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑条件：最少人次", exact: true }).click();
  await expect(inspector.getByLabel("最少人次默认值", { exact: true })).toHaveValue("25");
  const list = await page.locator(".condition-list").boundingBox();
  const panel = await inspector.boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(list!.x + list!.width);
  await page.getByRole("button", { name: "添加条件", exact: true }).click();
  await expect(inspector.getByLabel("参数名称4", { exact: true })).toHaveValue("新条件");
  await inspector.getByRole("button", { name: "删除条件", exact: true }).click();
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await expect(page.locator(".condition-summary")).toHaveCount(3);
  await expect(inspector.getByLabel("最少人次默认值", { exact: true })).toHaveValue("25");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inspector.getByLabel("参数名称1", { exact: true }).scrollIntoViewIfNeeded();
  await expect(inspector.getByLabel("参数名称1", { exact: true })).toBeVisible();
});
