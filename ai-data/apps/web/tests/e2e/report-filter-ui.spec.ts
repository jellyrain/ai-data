import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ReportDefinitionVersion, SaveReportDefinitionInput } from "@ai-data/contracts";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = fileURLToPath(new URL("../../../../../任务交接/筛选条件调整验收/", import.meta.url));
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
test("直接填写筛选、恢复默认和空值保持独立，详情 16:9 截图", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page);
  await page.goto("/reports/report-01");
  await expect(page.getByRole("textbox", { name: "最少人次", exact: true })).toHaveValue("10");
  await expect(page.getByRole("combobox", { name: "包含停用", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "最少人次取值方式" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "最少人次", exact: true }).fill("0");
  await page.getByRole("button", { name: "最少人次取值设置", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "最少人次", exact: true })).toHaveValue("10");
  await page.getByRole("button", { name: "备注条件取值设置", exact: true }).click();
  await page.getByRole("button", { name: "使用空值 NULL", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "备注条件", exact: true })).toBeDisabled();
  const bodies: { parameters: Record<string, unknown> }[] = [];
  await page.route("**/reports/report-01/execute", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect(page.getByText("运行完成", { exact: true })).toBeVisible();
  expect(bodies[0]!.parameters).toEqual({ flag: false, note: null });
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "备注条件", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "报表内容", exact: true }).press("Enter");
  await page.getByRole("option", { name: "科室分布", exact: true }).click();
  await expect(page.locator(".result-chart canvas")).toBeVisible();
  await shot(page, "02-详情筛选栏-改后");
});
test("条件内编辑关联只修改当前项，多查询和复杂绑定保持；编辑页截图", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await login(page);
  let initialized = false;
  const writes: SaveReportDefinitionInput[] = [];
  await page.route("**/reports/report-14/definition", async (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      return route.continue();
    }
    if (initialized) return route.continue();
    initialized = true;
    const response = await route.fetch();
    const record = (await response.json()) as ReportDefinitionVersion;
    record.definition.queries[0]!.bindings = [
      { parameter: "min", target: { type: "filter", field: "v.count", op: "eq", scope: "query" } },
      {
        parameter: "note",
        target: { type: "filter", field: "v.department", op: "eq", scope: "from", alias: "v" },
      },
    ];
    record.definition.queries[1]!.bindings = [
      { parameter: "min", target: { type: "filter", field: "v.count", op: "eq", scope: "query" } },
    ];
    await route.fulfill({ response, json: record });
  });
  await page.goto("/reports/report-14/edit");
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  const first = page.getByRole("region", { name: "条件属性" });
  await expect(first.locator(".condition-query-binding")).toHaveCount(2);
  await expect(page.getByLabel("参数标识1", { exact: true })).toBeHidden();
  await expect(first.locator(".condition-required")).toBeVisible();
  await expect(first.locator(".condition-required")).toHaveCSS("flex-direction", "row");
  await first.getByLabel("最少人次默认值", { exact: true }).fill("20");
  await first.getByLabel("最少人次默认值", { exact: true }).press("Tab");
  await expect(
    page.locator(".parameter-preview").getByLabel("最少人次", { exact: true }),
  ).toHaveValue("20");
  const visit = first.locator(".condition-query-binding").first();
  await visit.getByText("生效位置 · 查询结果", { exact: true }).click();
  await visit.getByRole("combobox", { name: "绑定位置1", exact: true }).press("Enter");
  await page.getByRole("option", { name: "主对象预过滤", exact: true }).click();
  await visit.getByText("生效位置 · 主对象预过滤", { exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]!.definition.queries[0]!.bindings).toEqual([
    {
      parameter: "min",
      target: { type: "filter", field: "v.count", op: "eq", scope: "from", alias: "v" },
    },
    {
      parameter: "note",
      target: { type: "filter", field: "v.department", op: "eq", scope: "from", alias: "v" },
    },
  ]);
  expect(writes[0]!.definition.queries[1]!.bindings[0]!.target).toMatchObject({ scope: "query" });
  await expect(page.locator(".editor-save-state")).toContainText("v3");
  await page.reload();
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  await expect(
    page.locator(".parameter-preview").getByLabel("最少人次", { exact: true }),
  ).toHaveValue("20");
  await shot(page, "01-筛选条件编辑-改后");
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
  await expect(page.locator(".appearance-panel")).not.toBeVisible();
  await shot(page, "03-筛选条件编辑-暗色");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "04-筛选条件编辑-手机");
});
test("相对日期默认提示、双值范围和手动日期提交", async ({ page }) => {
  await login(page);
  await page.route("**/reports/report-03/definition**", async (route) => {
    const response = await route.fetch();
    const record = (await response.json()) as ReportDefinitionVersion;
    record.definition.parameters.push({
      name: "dates",
      label: "日期范围",
      data_type: "date",
      required: true,
      relative_time: {
        range: { type: "relative", period: "this_year", extent: "to_date" },
        part: "range",
      },
    });
    record.definition.parameters.push({
      name: "limits",
      label: "人数范围",
      data_type: "integer",
      required: false,
      default_value: [0, 100],
    });
    record.definition.queries[0]!.bindings.push({
      parameter: "limits",
      target: { type: "filter", field: "v.count", op: "between", scope: "query" },
    });
    await route.fulfill({ response, json: record });
  });
  await page.goto("/reports/report-03");
  await expect(page.getByPlaceholder("本年 · 截至当天", { exact: true })).toBeVisible();
  await expect(page.getByLabel("人数范围开始值", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("人数范围结束值", { exact: true })).toHaveValue("100");
  const bodies: { parameters: Record<string, unknown> }[] = [];
  await page.route("**/reports/report-03/execute", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 403,
      json: { code: "POLICY_REJECTED", message: "仅校验参数提交" },
    });
  });
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]!.parameters).toEqual({});
  // 授权拒绝会清理定义，重新读取后再验证手动覆盖；不绕过这项安全行为。
  await page.reload();
  await expect(page.getByPlaceholder("本年 · 截至当天", { exact: true })).toBeVisible();
  const dates = page
    .locator(".parameter-range-item")
    .filter({ hasText: "日期范围" })
    .locator("input");
  await dates.nth(0).fill("2026-01-01");
  await dates.nth(1).fill("2026-10-04");
  await dates.nth(1).press("Tab");
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]!.parameters.dates).toEqual(["2026-01-01", "2026-10-04"]);
});
