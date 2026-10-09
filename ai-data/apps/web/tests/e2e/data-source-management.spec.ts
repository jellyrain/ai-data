import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { managementFixture } from "../support/management-fixture";
const evidence = fileURLToPath(
  new URL("../../../../../任务交接/数据源交互与删除验收/", import.meta.url),
);
async function open(page: Page) {
  const fixture = await managementFixture(page);
  await page.goto("/settings/data");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.getByRole("combobox", { name: "DAS 实例" }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  await mkdir(evidence, { recursive: true });
  return fixture;
}
async function check(page: Page, name: string, checked: boolean) {
  const input = page.getByRole("checkbox", { name, exact: true });
  if ((await input.isChecked()) !== checked) await input.locator("xpath=ancestor::label").click();
  await expect(input).toBeChecked({ checked });
}
test("打开目标数据库即查询，失败在下拉内重试且不保存", async ({ page }) => {
  const fixture = await open(page);
  fixture.sourceMode.failTargets = true;
  const field = page.getByRole("combobox", { name: "目标数据库", exact: true });
  await expect(page.getByRole("button", { name: "发现目标数据库", exact: true })).toHaveCount(0);
  await field.click();
  await expect(page.getByText("数据库查询失败，请重试", { exact: true })).toBeVisible();
  fixture.sourceMode.failTargets = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("option", { name: "archive", exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/数据库下拉查询.png`, animations: "disabled" });
  await page.getByRole("option", { name: "ai_bi_demo", exact: true }).click();
  expect(fixture.writes.filter((w) => w.path.endsWith("/demo-ref/test"))).toHaveLength(2);
  expect(fixture.writes.filter((w) => w.path.endsWith("/data-sources"))).toHaveLength(0);
});
test("白名单可直接取消和恢复，保留逻辑名与编辑配置并持久化移除", async ({ page }) => {
  const fixture = await open(page);
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await page.getByRole("button", { name: "发现数据库对象", exact: true }).click();
  await expect(page.getByText(/已发现 24 个对象/)).toBeVisible();
  await check(page, "选择 visits", false);
  await check(page, "选择 visits", true);
  await expect(page.getByRole("button", { name: "保存完整白名单" })).toBeDisabled();
  await page.getByRole("button", { name: "配置 visits", exact: true }).click();
  await check(page, "允许查询", false);
  await page.getByRole("button", { name: "应用对象编辑" }).click();
  await check(page, "选择 visits", false);
  await check(page, "选择 visits", true);
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await expect(page.getByText(/完整白名单已保存并回读/)).toBeVisible();
  expect(
    fixture.writes.filter((w) => w.path.endsWith("/data-source-objects")).at(-1)?.body,
  ).toMatchObject({
    objects: [
      {
        object_id: "visits",
        discovered_object_id: "table.dbo.inpatient",
        is_queryable: false,
        query_capabilities: { sortable_fields: [] },
      },
    ],
  });
  await check(page, "选择 table.dbo.department_1", true);
  await check(page, "选择 visits", false);
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await expect(page.getByText(/共 1 个对象/)).toBeVisible();
  await page.getByRole("button", { name: "重新读取白名单" }).click();
  await check(page, "只看已选", true);
  await expect(page.getByRole("table", { name: "对象白名单列表" }).getByRole("row")).toHaveCount(2);
  await page
    .getByRole("checkbox", { name: "选择 table.dbo.department_1", exact: true })
    .locator("xpath=ancestor::label")
    .click();
  await expect(page.getByRole("table", { name: "对象白名单列表" }).getByRole("row")).toHaveCount(1);
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText(/共 0 个对象/)).toBeVisible();
});
test("白名单在桌面亮暗与手机布局中对齐且可取消", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await page.getByRole("button", { name: "发现数据库对象", exact: true }).click();
  await expect(page.getByText(/已发现 24 个对象/)).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .getByRole("heading", { name: "对象白名单", exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${evidence}/白名单-${width}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).press("Escape");
  await expect(page.getByRole("region", { name: "外观设置" })).toBeHidden();
  await page.screenshot({ path: `${evidence}/白名单-暗色.png`, animations: "disabled" });
  expect(errors).toEqual([]);
});
test("中文表、视图及美元符号字段可发现，白名单保存回读并取消", async ({ page }) => {
  const fixture = await open(page);
  fixture.sourceMode.chineseObjects = true;
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await page.getByRole("button", { name: "发现数据库对象", exact: true }).click();
  await expect(page.getByText(/已发现 3 个对象/)).toBeVisible();
  await check(page, "选择 table.dbo.科室", true);
  await check(page, "选择 view.dbo.科室视图", true);
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await expect(page.getByText(/共 3 个对象/)).toBeVisible();
  await page.getByRole("button", { name: "重新读取白名单" }).click();
  await expect(
    page.getByRole("checkbox", { name: "选择 view.dbo.科室视图", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("row").filter({ hasText: "view.dbo.科室视图" })).toContainText(
    "视图",
  );
  await page.screenshot({
    path: `${evidence}/中文及美元符号字段.png`,
    animations: "disabled",
    fullPage: true,
  });
  await check(page, "选择 view.dbo.科室视图", false);
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await expect(page.getByText(/共 2 个对象/)).toBeVisible();
  const saved = fixture.writes.filter((write) => write.path.endsWith("/data-source-objects")).at(-1)
    ?.body as { objects: { object_id: string }[] };
  expect(saved.objects.map((item) => item.object_id)).toContain("table.dbo.科室");
  expect(saved.objects.map((item) => item.object_id)).not.toContain("view.dbo.科室视图");
});
test("删除可取消，版本冲突不丢源，回执失败需重试完成清理", async ({ page }) => {
  const fixture = await open(page);
  await page.getByRole("button", { name: "删除数据源", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("业务数据和历史记录会保留");
  await page.screenshot({ path: `${evidence}/删除确认.png`, animations: "disabled" });
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(fixture.writes.filter((w) => w.path.endsWith("/data-sources/delete"))).toHaveLength(0);
  fixture.sourceMode.deleteConflict = true;
  await page.getByRole("button", { name: "删除数据源", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText(/删除未完成/)).toBeVisible();
  await page.getByRole("button", { name: "返回数据源列表", exact: true }).click();
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  fixture.sourceMode.deleteConflict = false;
  fixture.sourceMode.dropDeleteReceipt = true;
  await page.getByRole("button", { name: "删除数据源", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("数据源已删除。", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试删除清理", exact: true })).toBeVisible();
  fixture.sourceMode.dropDeleteReceipt = false;
  await page.getByRole("button", { name: "重试删除清理", exact: true }).click();
  await expect(page.getByText("数据源已删除。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /clinical clinical 启用/ })).toHaveCount(0);
  await page.getByRole("button", { name: "数据库连接", exact: true }).click();
  await expect(page.getByRole("button", { name: /demo-ref .* SQL Server/ })).toBeVisible();
  expect(fixture.writes.filter((w) => w.path.endsWith("/data-sources/delete"))).toHaveLength(3);
});

test("五百个对象从当前行打开抽屉，编辑和关闭保留列表位置", async ({ page }) => {
  const fixture = await open(page);
  fixture.sourceMode.objectCount = 500;
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await page.getByRole("button", { name: "发现数据库对象", exact: true }).click();
  await expect(page.getByText(/已发现 500 个对象/)).toBeVisible();
  await page.getByLabel("搜索发现对象").fill("department_");
  await page.locator(".el-pager").getByText("3", { exact: true }).click();
  const id = "table.dbo.department_41";
  await check(page, `选择 ${id}`, true);
  const trigger = page.getByRole("button", { name: `配置 ${id}`, exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const before = await trigger.boundingBox();
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: `配置 ${id}`, exact: true });
  await expect(drawer).toBeVisible();
  const bounds = await drawer.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(640);
  await check(page, "允许查询", false);
  await drawer.getByRole("button", { name: "取消", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "放弃对象编辑", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "应用对象编辑", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByLabel("搜索发现对象")).toHaveValue("department_");
  await expect(page.locator(".el-pager .is-active")).toHaveText("3");
  expect(Math.abs((await trigger.boundingBox())!.y - before!.y)).toBeLessThan(3);
  await trigger.click();
  await expect(page.getByRole("checkbox", { name: "允许查询", exact: true })).not.toBeChecked();
  await page.screenshot({ path: `${evidence}/白名单配置抽屉.png`, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBeLessThanOrEqual(390);
  await drawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.getByRole("button", { name: "保存完整白名单", exact: true }).click();
  await expect(page.getByText(/完整白名单已保存并回读/)).toBeVisible();
  const saved = fixture.writes.filter((write) => write.path.endsWith("/data-source-objects")).at(-1)
    ?.body as { objects: { object_id: string; is_queryable: boolean }[] };
  expect(saved.objects.find((item) => item.object_id === id)?.is_queryable).toBe(false);
});
