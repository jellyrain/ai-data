import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { managementFixture } from "../support/management-fixture";
import { knowledgeFixture } from "../support/knowledge-fixture";

const output = fileURLToPath(
  new URL("../../../../../任务交接/Web全站Linear风格验收/", import.meta.url),
);
test.use({ viewport: { width: 1920, height: 1080 } });

async function theme(page: Page, mode = "暗色") {
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page.getByRole("button", { name: "紫罗兰", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
  await expect(page.locator(".appearance-panel")).toBeHidden();
}
async function login(page: Page, user = "editor") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(user);
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
  await theme(page);
}
async function shot(page: Page, name: string) {
  await mkdir(output, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled", fullPage: false });
}
async function choose(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).press("Enter");
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("全站视觉验收：登录、分析工作台与完成后的过程折叠", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/login");
  await theme(page);
  await shot(page, "01-登录-暗色");
  await theme(page, "亮色");
  await shot(page, "02-登录-亮色");
  await login(page);
  await shot(page, "03-分析工作台");
  await page.getByLabel("分析问题").fill("流式分析本年各科室门诊数据");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: /查看分析过程/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.locator(".analysis-messages").evaluate((el) => {
    el.scrollTop = 0;
  });
  await shot(page, "04-分析完成");
  await page.getByRole("button", { name: /查看分析过程/ }).click();
  await shot(page, "05-展开分析过程");
});

test("全站视觉验收：报表中心、详情、筛选、展示、画布与弹窗", async ({ page }) => {
  test.setTimeout(120000);
  await login(page);
  await page.goto("/reports");
  await expect(page.locator(".report-card").first()).toBeVisible();
  await shot(page, "06-报表中心");
  await page.goto("/reports/report-01");
  await choose(page, "报表内容", "科室分布");
  await expect(page.locator(".result-chart canvas")).toBeVisible();
  await shot(page, "07-报表图表");
  await theme(page, "亮色");
  await shot(page, "08-报表图表-亮色");
  await theme(page);
  await page.getByRole("button", { name: "查看表格", exact: true }).click();
  await expect(page.locator(".virtual-table")).toBeVisible();
  await shot(page, "09-报表明细");
  for (const [button, name] of [
    ["分享", "10-分享设置"],
    ["导出", "11-导出文件"],
    ["结果历史", "12-结果历史"],
    ["提交为组织模板", "13-提交模板"],
  ]) {
    await page.getByRole("button", { name: button!, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, name!);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "编辑报表", exact: true }).click();
  await expect(page.getByText(/使用上次保存结果/)).toBeVisible();
  await shot(page, "14-数据与展示");
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  await expect(page.getByRole("region", { name: "条件属性" })).toBeVisible();
  await shot(page, "15-筛选条件");
  await theme(page, "亮色");
  await shot(page, "16-筛选条件-亮色");
  await theme(page);
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  await expect(page.locator(".query-node").first()).toBeVisible();
  await shot(page, "17-数据编排画布");
  await page.getByRole("button", { name: "打开查询属性", exact: true }).click();
  await shot(page, "18-画布属性");
  await page.getByRole("button", { name: "数据与展示", exact: true }).click();
  await page.getByRole("button", { name: "AI 修改", exact: true }).click();
  await expect(page.getByLabel("AI 修改要求")).toBeVisible();
  await shot(page, "19-AI修改");
  await page.getByRole("button", { name: "收起 AI 修改", exact: true }).click();
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await shot(page, `30-筛选条件-${width}`);
  }
});

test("全站视觉验收：模型、Agent、用户、权限与数据管理", async ({ page }) => {
  test.setTimeout(120000);
  await managementFixture(page);
  await login(page, "admin");
  await page.goto("/settings/models");
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await shot(page, "20-模型管理");
  await page.goto("/settings/agents");
  await page.getByRole("button", { name: /住院分析助手 clinical/ }).click();
  await shot(page, "21-Agent管理");
  await page.goto("/settings/users");
  await page.locator(".management-resource").first().click();
  await shot(page, "22-用户管理");
  await page.goto("/settings/permissions");
  await choose(page, "策略数据源", "clinical");
  await choose(page, "策略角色", "业务分析员 · analyst");
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await shot(page, "23-角色与权限");
  await page.goto("/settings/data");
  await choose(page, "DAS 实例", "das-demo · 在线");
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  await expect(page.getByRole("heading", { name: "数据源配置", exact: true })).toBeVisible();
  await shot(page, "24-数据管理");
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await choose(page, "业务数据源", "clinical · healthy");
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await shot(page, "25-业务目录");
  await theme(page, "亮色");
  await shot(page, "26-业务目录-亮色");
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await shot(page, `31-数据管理-${width}`);
  }
});

test("全站视觉验收：知识、偏好、审核和后台任务", async ({ page }) => {
  test.setTimeout(90000);
  await knowledgeFixture(page);
  await login(page, "admin");
  await page.goto("/settings/knowledge");
  await page.getByRole("button", { name: "提交知识候选", exact: true }).click();
  await page.getByLabel("知识标题", { exact: true }).fill("住院费用统计口径");
  await page
    .getByLabel("知识正文", { exact: true })
    .fill("按出院日期统计，费用按有效记账记录汇总。\n科室以出院科室为准，退费计入发生当期。");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect(page.getByText("候选已保存", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "搜索负责人", exact: true }).click();
  await choose(page, "负责人", "测试管理员 · admin");
  await page.getByRole("button", { name: "分配负责人", exact: true }).click();
  await shot(page, "27-知识审核");
  await page.getByLabel("审核意见", { exact: true }).fill("口径核对通过");
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await page.getByLabel("知识生效时间", { exact: true }).fill("2026-10-03 09:00:00");
  await page.getByRole("button", { name: "发布知识", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("heading", { name: "审核记录" })).toBeVisible();
  await page.goto("/knowledge");
  await page.locator(".management-resource").first().click();
  await shot(page, "28-企业知识");
  await page.getByRole("button", { name: "个人偏好", exact: true }).click();
  await page.getByRole("button", { name: "新增偏好", exact: true }).click();
  await page.getByLabel("偏好标识", { exact: true }).fill("default-time");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect(page.getByText("偏好已保存", { exact: false })).toBeVisible();
  await shot(page, "29-个人偏好");
  await page.goto("/settings/tasks");
  await expect(page.getByText("MODEL_TIMEOUT", { exact: false })).toBeVisible();
  await shot(page, "32-后台任务");
});
