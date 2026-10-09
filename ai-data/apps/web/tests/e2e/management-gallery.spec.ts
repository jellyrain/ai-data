import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { managementFixture } from "../support/management-fixture";
import { knowledgeFixture } from "../support/knowledge-fixture";

const output = fileURLToPath(
  new URL("../../../../../任务交接/管理页面布局调整验收/", import.meta.url),
);
test.use({ viewport: { width: 1920, height: 1080 } });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
  await theme(page);
}
async function theme(page: Page, mode = "暗色", palette = "紫罗兰") {
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page.getByRole("button", { name: palette, exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
}
async function choose(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function shot(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.querySelector("#main-content")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: output + name + ".png", fullPage: false, animations: "disabled" });
}

test("管理效果验收：模型、Agent 与用户布局", async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await managementFixture(page);
  fixture.users.push(
    ...["李静", "王磊", "陈雪", "赵宁", "刘洋"].map((name, index) => ({
      ...fixture.users[0]!,
      id: "gallery-" + index,
      username: ["lijing", "wanglei", "chenxue", "zhaoning", "liuyang"][index]!,
      display_name: name,
      status: index === 4 ? "disabled" : index === 3 ? "pending" : "active",
    })),
  );
  await login(page);
  await page.goto("/settings/models");
  await expect(page.locator(".management-card")).toHaveCount(1);
  await shot(page, "01-模型管理-暗色");
  await page.getByRole("button", { name: /院内模型 rj/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toBeVisible();
  await shot(page, "02-模型配置-暗色");
  await theme(page, "亮色");
  await shot(page, "03-模型配置-亮色");
  await theme(page);
  await page.goto("/settings/agents");
  await expect(page.locator(".management-card")).toHaveCount(1);
  await shot(page, "04-Agent管理");
  await page.getByRole("button", { name: /住院分析助手 clinical/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await expect(page.getByLabel("名称", { exact: true })).toBeVisible();
  await shot(page, "05-Agent配置");
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await expect(page.getByText("get_tool_schema", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /get_tool_schema/ })).toBeChecked();
  await shot(page, "06-Agent工具");
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "住院业务员", exact: true }).click();
  await expect(page.getByRole("region", { name: "用户详情" })).toBeVisible();
  await shot(page, "07-用户管理");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "08-用户管理-窄屏");
  await page.getByRole("region", { name: "用户详情" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "保存部门范围" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("管理效果验收：权限、数据源与业务目录", async ({ page }) => {
  test.setTimeout(90000);
  await managementFixture(page);
  await login(page);
  await page.goto("/settings/permissions");
  await choose(page, "策略数据源", "clinical");
  await choose(page, "策略角色", "业务分析员 · analyst");
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await expect(page.getByRole("button", { name: "保存对象权限", exact: true })).toBeVisible();
  await shot(page, "09-角色与权限");
  await page.goto("/settings/data");
  await choose(page, "DAS 实例", "das-demo · 在线");
  await expect(page.locator(".management-card")).toHaveCount(1);
  await shot(page, "10-数据源中心");
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  await expect(page.getByRole("heading", { name: "数据源配置", exact: true })).toBeVisible();
  await shot(page, "11-数据源配置");
  await page.getByRole("button", { name: "对象白名单", exact: true }).click();
  await page.getByRole("button", { name: /visits visits 可查询/ }).click();
  await shot(page, "12-对象白名单");
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await choose(page, "业务数据源", "clinical · healthy");
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await shot(page, "13-业务目录");
  for (const palette of ["橄榄绿", "海蓝", "青绿", "紫罗兰"]) {
    await theme(page, "亮色", palette);
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    }
  }
});

test("管理效果验收：知识审核与后台任务", async ({ page }) => {
  test.setTimeout(60000);
  await knowledgeFixture(page);
  await login(page);
  await page.goto("/settings/knowledge");
  await page.getByRole("button", { name: "提交知识候选", exact: true }).click();
  await page.getByLabel("知识标题", { exact: true }).fill("住院费用统计口径");
  await page
    .getByLabel("知识正文", { exact: true })
    .fill("按出院日期统计，费用按有效记账记录汇总。科室以出院科室为准，退费计入发生当期。");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect(page.getByText(/候选已保存/)).toBeVisible();
  await shot(page, "14-知识审核-内容");
  await page.getByRole("button", { name: "负责人和审核", exact: true }).click();
  await page.getByRole("button", { name: "搜索负责人", exact: true }).click();
  await choose(page, "负责人", "测试管理员 · admin");
  await page.getByRole("button", { name: "分配负责人", exact: true }).click();
  await expect(page.getByLabel("审核意见", { exact: true })).toBeVisible();
  await shot(page, "15-知识审核-操作");
  await page.goto("/settings/tasks");
  await expect(page.getByText("MODEL_TIMEOUT", { exact: false })).toBeVisible();
  await shot(page, "16-后台任务");
});
