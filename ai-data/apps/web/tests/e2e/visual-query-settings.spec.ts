import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { managementFixture } from "../support/management-fixture";
const evidence = fileURLToPath(
  new URL("../../../../../任务交接/可视化高级配置验收/", import.meta.url),
);
test.beforeEach(async () => {
  await mkdir(evidence, { recursive: true });
});
test.setTimeout(60000);
async function login(page: Page) {
  await page.goto("/settings/data");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
}
async function option(page: Page, label: string, name: string) {
  const select = page.getByRole("combobox", { name: label, exact: true });
  const wrapper = select.locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]");
  await wrapper.scrollIntoViewIfNeeded();
  const bounds = await wrapper.boundingBox();
  await wrapper.click({ position: { x: bounds!.width - 14, y: bounds!.height / 2 } });
  const list = page.locator(`[id="${await select.getAttribute("aria-controls")}"]`);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const choice = list.getByRole("option", { name: new RegExp(`^${escaped}(?:\\s|$)`) });
  await expect(choice).toBeVisible();
  await choice.click();
  await select.press("Escape");
}
async function catalog(page: Page) {
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await option(page, "业务数据源", "clinical · healthy");
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await page.locator("summary").filter({ hasText: "高级能力与参数策略" }).click();
}

test("白名单自动读取字段，可视化选择排序和统计并保存回读", async ({ page }) => {
  const fixture = await managementFixture(page);
  fixture.datasets[0]!.columns.push({ name: "科室$名称", data_type: "string", nullable: true });
  await login(page);
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await option(page, "DAS 实例", "das-demo · 在线");
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await page.getByRole("button", { name: "配置 visits", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "配置 visits", exact: true });
  await expect(page.getByRole("combobox", { name: "排序配置方式" })).toBeEnabled();
  await expect(drawer.locator("textarea")).toHaveCount(0);
  await option(page, "排序配置方式", "自定义");
  await option(page, "排序字段", "科室$名称");
  await option(page, "统计配置方式", "自定义");
  await option(page, "统计字段", "amount");
  for (const name of ["计数", "去重计数", "最小值", "最大值"])
    await option(page, "amount统计函数", name);
  await page.screenshot({ path: `${evidence}/白名单查询能力.png`, animations: "disabled" });
  await page.getByRole("button", { name: "应用对象编辑" }).click();
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await expect(page.getByText(/完整白名单已保存并回读/)).toBeVisible();
  expect(
    fixture.writes.filter((w) => w.path.endsWith("/data-source-objects")).at(-1)?.body,
  ).toMatchObject({
    objects: [
      {
        object_id: "visits",
        query_capabilities: {
          sortable_fields: ["科室$名称"],
          aggregations: [{ field: "amount", functions: ["sum", "avg"] }],
        },
      },
    ],
  });
  await page.getByRole("button", { name: "配置 visits", exact: true }).click();
  await expect(drawer).toContainText("科室$名称");
  await option(page, "统计配置方式", "禁用");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("dialog", { name: "放弃对象编辑" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await page.getByRole("button", { name: "配置 visits", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "amount统计函数" })).toBeVisible();
});

test("业务查询能力保留默认和禁用，并只提供源允许的统计选项", async ({ page }) => {
  const fixture = await managementFixture(page);
  fixture.datasets[0]!.query_capabilities = {
    sortable_fields: ["amount"],
    aggregations: [{ field: "amount", functions: ["sum"] }],
  };
  await login(page);
  await catalog(page);
  const advanced = page.locator(".catalog-advanced");
  await expect(advanced.locator("textarea")).toHaveCount(0);
  await expect(advanced).toContainText("当前对象没有输入参数");
  await option(page, "排序配置方式", "默认");
  await option(page, "分组配置方式", "禁用");
  await option(page, "统计配置方式", "自定义");
  await option(page, "统计字段", "amount");
  await expect(page.getByRole("combobox", { name: "amount统计函数" })).toBeVisible();
  await page.getByRole("button", { name: "保存业务配置" }).click();
  await expect(page.getByText("业务目录配置已保存并回读。")).toBeVisible();
  const body = fixture.writes.filter((w) => w.path === "/admin/catalog/datasets").at(-1)?.body as {
    query_capabilities: Record<string, unknown>;
  };
  expect(body.query_capabilities).toEqual({
    groupable_fields: [],
    aggregations: [{ field: "amount", functions: ["sum"] }],
  });
  await page.locator("summary").filter({ hasText: "高级能力与参数策略" }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await advanced.screenshot({ path: `${evidence}/业务能力手机.png`, animations: "disabled" });
});

test("参数策略和权限绑定通过选择完成，零值保存且源必填不能放宽", async ({ page }) => {
  const fixture = await managementFixture(page);
  fixture.datasets[0]!.kind = "stored_procedure";
  fixture.datasets[0]!.query_parameters = [
    {
      name: "科室参数",
      data_type: "string",
      allowed_ops: ["eq"],
      required: true,
      default_value: "D01",
    },
    { name: "金额参数", data_type: "decimal", allowed_ops: ["eq", "between"], required: false },
  ];
  await login(page);
  await catalog(page);
  await page.getByRole("button", { name: "配置参数 科室参数", exact: true }).click();
  const required = page.getByRole("combobox", { name: "科室参数必填策略" });
  await required.locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]").click();
  await expect(
    page
      .locator(`[id="${await required.getAttribute("aria-controls")}"]`)
      .getByRole("option", { name: "选填", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await required.press("Escape");
  await page.getByRole("button", { name: "配置参数 金额参数", exact: true }).click();
  await option(page, "金额参数参数默认值方式", "指定值");
  await page.getByRole("textbox", { name: "金额参数参数默认值", exact: true }).fill("0");
  await page.getByRole("button", { name: "添加权限绑定" }).click();
  await page.getByRole("button", { name: "添加权限绑定" }).click();
  await page.getByRole("button", { name: "保存业务配置" }).click();
  await expect(page.getByText("业务目录配置已保存并回读。")).toBeVisible();
  expect(
    fixture.writes.filter((w) => w.path === "/admin/catalog/datasets").at(-1)?.body,
  ).toMatchObject({
    query_parameter_policies: [{ name: "科室参数" }, { name: "金额参数", default_value: 0 }],
    query_permission_bindings: [
      { field: "department_id", parameter: "科室参数", operator: "eq" },
      { field: "amount", parameter: "金额参数", operator: "eq" },
    ],
  });
  await page.locator("summary").filter({ hasText: "高级能力与参数策略" }).click();
  await expect(page.getByRole("textbox", { name: "金额参数参数默认值", exact: true })).toHaveValue(
    "0",
  );
  await page
    .locator(".parameter-editor")
    .screenshot({ path: `${evidence}/业务参数策略.png`, animations: "disabled" });
  await page
    .locator(".binding-editor")
    .screenshot({ path: `${evidence}/权限参数绑定.png`, animations: "disabled" });
});
