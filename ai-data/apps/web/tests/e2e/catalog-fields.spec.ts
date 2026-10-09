import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { managementFixture } from "../support/management-fixture";

const evidence = fileURLToPath(
  new URL("../../../../../任务交接/字段说明与脱敏验收/", import.meta.url),
);
test.setTimeout(60000);
async function option(page: Page, label: string, name: string) {
  const input = page.getByRole("combobox", { name: label, exact: true });
  const wrapper = input.locator("xpath=ancestor::div[contains(@class, 'el-select__wrapper')]");
  await wrapper.scrollIntoViewIfNeeded();
  const box = await wrapper.boundingBox();
  await wrapper.click({ position: { x: box!.width - 14, y: box!.height / 2 } });
  await page
    .locator(`[id="${await input.getAttribute("aria-controls")}"]`)
    .getByRole("option", { name, exact: true })
    .click();
  await input.press("Escape");
}
async function open(page: Page, many = false) {
  const fixture = await managementFixture(page);
  fixture.datasets[0]!.columns = [
    { name: "id", data_type: "integer", nullable: false, source_description: "记录主键" },
    { name: "report_id", data_type: "string", nullable: true, source_description: "报告编号" },
    { name: "report_type", data_type: "string", nullable: true },
    ...(many
      ? Array.from({ length: 39 }, (_, i) => ({
          name: `field_${i + 1}`,
          data_type: "string" as const,
          nullable: true,
          source_description: `数据库注释 ${i + 1}`,
        }))
      : []),
  ];
  await page.goto("/settings/data");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await option(page, "业务数据源", "clinical · healthy");
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await mkdir(evidence, { recursive: true });
  return fixture;
}

test("字段注释、业务说明和脱敏分区，保存后可回读并恢复源注释", async ({ page }) => {
  const fixture = await open(page);
  const section = page.getByRole("region", { name: "字段说明与脱敏", exact: true });
  const row = section.getByRole("group", { name: "字段 report_id", exact: true });
  await expect(row.getByText("报告编号", { exact: true })).toBeVisible();
  await expect(row.getByRole("textbox", { name: "report_id 业务说明" })).toHaveAttribute(
    "placeholder",
    "留空沿用数据库注释",
  );
  await row.getByRole("textbox", { name: "report_id 业务说明" }).fill("检验报告唯一编号");
  await row.getByRole("button", { name: "配置脱敏 report_id" }).click();
  await option(page, "report_id 脱敏规则", "部分遮罩");
  await page.getByRole("spinbutton", { name: "report_id 保留开头字符" }).fill("3");
  await page.getByRole("spinbutton", { name: "report_id 保留结尾字符" }).fill("4");
  await option(page, "report_id 免脱敏角色", "业务分析员");
  await expect(row.getByLabel("report_id 脱敏效果示例")).toContainText(/^REP\*+6789$/);
  await page.getByRole("button", { name: "保存业务配置" }).click();
  await expect(page.getByText("业务目录配置已保存并回读。")).toBeVisible();
  const saved = fixture.writes.filter((w) => w.path === "/admin/catalog/datasets").at(-1)?.body;
  expect(saved).toMatchObject({
    column_descriptions: [{ field: "report_id", business_description: "检验报告唯一编号" }],
    column_policies: [
      {
        field: "report_id",
        default_masking: {
          type: "partial_mask",
          prefix_length: 3,
          suffix_length: 4,
          mask_character: "*",
        },
        unmasked_role_ids: ["analyst-role"],
      },
    ],
  });
  await expect(row.getByRole("textbox", { name: "report_id 业务说明" })).toHaveValue(
    "检验报告唯一编号",
  );
  await expect(row.getByText("报告编号", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "配置脱敏 report_id" }).click();
  await page.setViewportSize({ width: 1440, height: 2400 });
  await section.screenshot({ path: `${evidence}/字段说明亮色.png`, animations: "disabled" });
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "海蓝", exact: true }).click();
  await page.getByRole("button", { name: "海蓝", exact: true }).press("Escape");
  await expect(page.getByRole("button", { name: "海蓝", exact: true })).not.toBeVisible();
  await section.screenshot({ path: `${evidence}/字段说明暗色.png`, animations: "disabled" });
  await row.getByRole("textbox", { name: "report_id 业务说明" }).fill("");
  await expect(row.getByRole("textbox", { name: "report_id 业务说明" })).toHaveValue("");
  await option(page, "report_id 脱敏规则", "未配置");
  await expect(row.getByRole("textbox", { name: "report_id 业务说明" })).toHaveValue("");
  await page.getByRole("button", { name: "保存业务配置" }).click();
  await expect(page.getByText("业务目录配置已保存并回读。")).toBeVisible();
  expect(
    fixture.writes.filter((w) => w.path === "/admin/catalog/datasets").at(-1)?.body,
  ).toMatchObject({ column_descriptions: [], column_policies: [] });
  await expect(row.getByText("报告编号", { exact: true })).toBeVisible();
});

test("字段多页搜索包含注释和未保存业务说明，窄屏保持归属和可编辑性", async ({ page }) => {
  await open(page, true);
  const section = page.getByRole("region", { name: "字段说明与脱敏", exact: true });
  await expect(section.getByRole("group", { name: /^字段 / })).toHaveCount(20);
  await section.getByRole("button", { name: "下一页" }).click();
  await expect(section.getByRole("group", { name: "字段 field_18", exact: true })).toBeVisible();
  const search = section.getByRole("textbox", { name: "搜索字段" });
  await search.fill("报告编号");
  await expect(section.getByRole("group", { name: /^字段 / })).toHaveCount(1);
  await section.getByRole("textbox", { name: "report_id 业务说明" }).fill("院内报告索引");
  await search.fill("院内报告索引");
  await expect(section.getByRole("group", { name: /^字段 / })).toHaveCount(1);
  await search.fill("不存在的字段");
  await expect(section.getByText("没有匹配的字段")).toBeVisible();
  await search.fill("report");
  await page.setViewportSize({ width: 390, height: 844 });
  await section.getByRole("button", { name: "配置脱敏 report_id" }).click();
  await option(page, "report_id 脱敏规则", "部分遮罩");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // 长截图使用相同手机宽度增高视口，避免固定保存栏盖住被截取的字段。
  await page.setViewportSize({ width: 390, height: 2800 });
  await search.focus();
  await section.screenshot({ path: `${evidence}/字段说明手机.png`, animations: "disabled" });
});
