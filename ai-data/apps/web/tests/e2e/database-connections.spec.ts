import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { databaseConnectionFixture } from "../support/database-connection-fixture";
const evidence = fileURLToPath(
  new URL("../../../../../任务交接/数据库连接管理验收/", import.meta.url),
);
async function open(page: Page) {
  await page.goto("/settings/data");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.getByRole("button", { name: "数据库连接", exact: true }).click();
  await page.getByRole("combobox", { name: "DAS 实例" }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
}
test("空环境显式创建连接、测试并绑定数据源，类型只在连接中选择", async ({ page }) => {
  const f = await databaseConnectionFixture(page);
  await open(page);
  await expect(page.getByText("还没有数据库连接", { exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
  await page.getByRole("button", { name: "新建数据库连接", exact: true }).click();
  await expect(page.getByRole("button", { name: "测试连接", exact: true })).toBeVisible();
  await page.getByLabel("主机", { exact: true }).fill("sql.test");
  await page.getByLabel("数据库账号", { exact: true }).fill("reader");
  await page.getByLabel("密码", { exact: true }).fill("new-password");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功，发现 1 个数据库。")).toBeVisible();
  expect(f.connections.size).toBe(0);
  expect(f.tests[0]).toMatchObject({ host: "sql.test", password: "new-password" });
  expect(f.writes.some((write) => write.path === "database-connections")).toBe(false);
  await page.getByLabel("连接名称", { exact: true }).fill("hospital");
  await page.getByRole("button", { name: "保存数据库连接", exact: true }).click();
  await expect(page.getByText("数据库连接已保存，可以创建数据源。")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功，发现 1 个数据库。")).toBeVisible();
  await page.getByRole("button", { name: "创建数据源", exact: true }).click();
  await page.getByRole("button", { name: "新建数据源", exact: true }).click();
  await page.getByLabel("数据源标识", { exact: true }).fill("outpatient");
  await page.getByRole("combobox", { name: "数据库连接", exact: true }).click();
  await page.getByRole("option", { name: "hospital · SQL Server", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "数据库类型", exact: true })).toHaveCount(0);
  await expect(page.getByText("数据库类型：SQL Server", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "目标数据库", exact: true }).click();
  await page.getByRole("option", { name: "business", exact: true }).click();
  await page.getByRole("button", { name: "保存数据源", exact: true }).click();
  await expect(page.getByText("数据源配置已保存并回读，可继续发现对象。")).toBeVisible();
  expect(f.sources.get("outpatient")).toMatchObject({
    secret_ref: "hospital",
    connector_kind: "sqlserver",
    target_database: "business",
  });
  await mkdir(evidence, { recursive: true });
  await page.getByRole("heading", { name: "数据管理", exact: true }).click();
  await page.screenshot({ path: `${evidence}/数据源类型继承.png` });
  await page.getByRole("button", { name: "数据库连接", exact: true }).click();
  await expect(page.getByRole("button", { name: /^hospital .* SQL Server$/ })).toBeVisible();
  await page.screenshot({ path: `${evidence}/连接卡片-单连接.png`, fullPage: true });
  await page.getByRole("button", { name: /^hospital .* SQL Server$/ }).click();
  await expect(page.getByRole("button", { name: "删除连接", exact: true })).toBeDisabled();
});
test("中文连接与数据源可创建、回读和搜索，保存后名称不可修改", async ({ page }) => {
  const f = await databaseConnectionFixture(page);
  await open(page);
  await page.getByRole("button", { name: "新建数据库连接", exact: true }).click();
  await page.getByLabel("连接名称", { exact: true }).fill("医院业务库");
  await page.getByLabel("主机", { exact: true }).fill("sql.test");
  await page.getByLabel("数据库账号", { exact: true }).fill("reader");
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "保存数据库连接", exact: true }).click();
  await expect(page.getByText("数据库连接已保存，可以创建数据源。")).toBeVisible();
  await expect(page.getByLabel("连接名称", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功，发现 1 个数据库。")).toBeVisible();
  await page.getByRole("button", { name: "创建数据源", exact: true }).click();
  await page.getByRole("button", { name: "新建数据源", exact: true }).click();
  await page.getByLabel("数据源标识", { exact: true }).fill("门诊数据");
  await page.getByRole("combobox", { name: "数据库连接", exact: true }).click();
  await page.getByRole("option", { name: "医院业务库 · SQL Server", exact: true }).click();
  await page.getByRole("combobox", { name: "目标数据库", exact: true }).click();
  await page.getByRole("option", { name: "business", exact: true }).click();
  await page.getByRole("button", { name: "保存数据源", exact: true }).click();
  await expect(page.getByText("数据源配置已保存并回读，可继续发现对象。")).toBeVisible();
  await expect(page.getByLabel("数据源标识", { exact: true })).toBeDisabled();
  expect(f.sources.get("门诊数据")).toMatchObject({ secret_ref: "医院业务库" });
  await page.getByRole("button", { name: "返回数据源列表", exact: true }).click();
  await page.getByRole("button", { name: /门诊数据 门诊数据 启用/ }).click();
  await expect(page.getByLabel("数据源标识", { exact: true })).toHaveValue("门诊数据");
  await expect(page.getByLabel("数据源标识", { exact: true })).toBeDisabled();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: `${evidence}/中文连接与数据源.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "数据库连接", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索数据库连接" }).fill("医院");
  await page.getByRole("button", { name: /^医院业务库 .* SQL Server$/ }).click();
  await expect(page.getByLabel("连接名称", { exact: true })).toHaveValue("医院业务库");
  await expect(page.getByLabel("连接名称", { exact: true })).toBeDisabled();
  await page.getByLabel("主机", { exact: true }).fill("changed.test");
  await page.getByRole("button", { name: "保存数据库连接", exact: true }).click();
  await page
    .getByRole("dialog", { name: "更新数据库连接" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page.getByText("数据库连接已保存，可以创建数据源。")).toBeVisible();
  expect(f.connections.get("医院业务库")?.host).toBe("changed.test");
  expect(f.connections.size).toBe(1);
});
test("连接编辑保留密码，测试失败保留表单，未引用连接可删除", async ({ page }) => {
  const f = await databaseConnectionFixture(page, true);
  await open(page);
  await page.getByRole("button", { name: /^hospital .* SQL Server$/ }).click();
  await page.getByLabel("主机", { exact: true }).fill("new.test");
  f.mode.failTest = true;
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("主机", { exact: true })).toHaveValue("new.test");
  expect(f.connections.get("hospital")?.host).toBe("hospital.test");
  f.mode.failTest = false;
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("连接测试成功，发现 1 个数据库。")).toBeVisible();
  expect(f.tests.at(-1)).toMatchObject({
    host: "new.test",
    password: "",
    saved_connection: { secret_ref: "hospital" },
  });
  expect(f.connections.get("hospital")?.host).toBe("hospital.test");
  await page.getByLabel("端口", { exact: true }).fill("1434");
  await expect(page.getByText("连接测试成功，发现 1 个数据库。")).toHaveCount(0);
  await page.getByRole("button", { name: "保存数据库连接", exact: true }).click();
  await expect(page.getByText("数据库连接已保存，可以创建数据源。")).toBeVisible();
  expect(f.passwords.get("hospital")).toBe("original-password");
  expect(f.connections.get("hospital")?.host).toBe("new.test");
  await page.getByRole("button", { name: "删除连接", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("数据库连接已删除。")).toBeVisible();
  expect(f.connections.has("hospital")).toBe(false);
});
test("连接修改冲突保留草稿，放弃修改读取后权限撤回清理内容", async ({ page }) => {
  const f = await databaseConnectionFixture(page, true);
  await open(page);
  await page.getByRole("button", { name: /^hospital .* SQL Server$/ }).click();
  await page.getByLabel("主机", { exact: true }).fill("draft.test");
  f.mode.conflict = true;
  await page.getByRole("button", { name: "保存数据库连接", exact: true }).click();
  await expect(page.getByText(/连接名称已存在或内容已更新/)).toBeVisible();
  await expect(page.getByLabel("主机", { exact: true })).toHaveValue("draft.test");
  await expect(page.getByRole("button", { name: "保存数据库连接", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "读取当前连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃修改" });
  await expect(dialog).toBeVisible();
  await mkdir(evidence, { recursive: true });
  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const box = (await dialog.locator(".el-message-box").boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(Math.min(420, width - 32) + 1);
    expect(box.width).toBeGreaterThan(300);
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(3);
    await page.screenshot({ path: `${evidence}/确认框-${width}.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("主机", { exact: true })).toHaveValue("draft.test");
  f.mode.forbidden = true;
  await page.getByRole("button", { name: "读取当前连接", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.getByLabel("主机", { exact: true })).toHaveCount(0);
});
for (const receipt of ["dropReceipt", "invalidReceipt"] as const)
  test(`保存回执异常 ${receipt} 保留草稿并回读核对，避免自动重复更新密码`, async ({ page }) => {
    const f = await databaseConnectionFixture(page, true);
    await open(page);
    await page.getByRole("button", { name: /^hospital .* SQL Server$/ }).click();
    await page.getByLabel("密码", { exact: true }).fill("rotated-password");
    f.mode[receipt] = true;
    await page.getByRole("button", { name: "保存数据库连接", exact: true }).click();
    await expect(page.getByText(/保存结果待核对，草稿已保留/)).toBeVisible();
    expect(f.passwords.get("hospital")).toBe("rotated-password");
    expect(f.writes.filter((w) => w.path === "database-connections/hospital")).toHaveLength(1);
    await page.getByRole("button", { name: "读取当前连接", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  });
test("连接卡片搜索和亮暗窄屏布局可用，切换连接清空目标库", async ({ page }) => {
  const fixture = await databaseConnectionFixture(page, true);
  fixture.connections.get("hospital")!.source_ids = ["outpatient", "inpatient"];
  await open(page);
  await mkdir(evidence, { recursive: true });
  await expect(page.getByText("关联数据源", { exact: true })).toHaveCount(0);
  const search = page.getByRole("textbox", { name: "搜索数据库连接" });
  await search.fill("MySQL");
  await expect(page.getByRole("button", { name: /^hospital .* SQL Server$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^archive .* MySQL$/ })).toBeVisible();
  await search.fill("unmatched-host");
  await expect(page.getByText("没有匹配的连接", { exact: true })).toBeVisible();
  await search.fill("");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: /^hospital .* SQL Server$/ })).toBeVisible();
    await page.screenshot({ path: `${evidence}/连接卡片-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${evidence}/连接列表.png`, fullPage: true });
  await page.getByRole("button", { name: /^hospital .* SQL Server$/ }).press("Enter");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const editor = page.getByRole("region", { name: "数据库连接编辑" });
    const form = await editor.locator("form").boundingBox();
    const actions = await editor.locator(".connection-actions").boundingBox();
    expect(form).not.toBeNull();
    expect(actions!.y).toBeGreaterThanOrEqual(form!.y + form!.height);
    await page.screenshot({ path: `${evidence}/连接编辑-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).press("Escape");
  await expect(page.getByRole("region", { name: "外观设置" })).toBeHidden();
  await page.screenshot({ path: `${evidence}/连接编辑-暗色.png`, fullPage: true });
  await page.getByRole("button", { name: "返回数据库连接列表" }).click();
  await expect(page.getByRole("button", { name: /^hospital .* SQL Server$/ })).toBeVisible();
  await page.screenshot({ path: `${evidence}/连接卡片-暗色.png`, fullPage: true });
  await page.getByRole("button", { name: "数据源", exact: true }).click();
  await page.getByRole("button", { name: "新建数据源", exact: true }).click();
  await page.getByRole("combobox", { name: "数据库连接", exact: true }).click();
  await page.getByRole("option", { name: "hospital · SQL Server", exact: true }).click();
  await page.getByRole("combobox", { name: "目标数据库", exact: true }).click();
  await page.getByRole("option", { name: "business", exact: true }).click();
  await page.getByRole("combobox", { name: "数据库连接", exact: true }).click();
  await page.getByRole("option", { name: "archive · MySQL", exact: true }).click();
  await expect(page.getByText("数据库类型：MySQL", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "目标数据库", exact: true })).toHaveValue("");
});
