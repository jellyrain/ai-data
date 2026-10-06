import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第5步验收/", import.meta.url));
async function login(page: Page, username = "analyst") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "报表中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "报表中心", exact: true })).toBeVisible();
}
async function openReport(page: Page) {
  await login(page);
  await page.getByRole("link", { name: /门诊与费用月报/ }).click();
  await expect(page.getByRole("heading", { name: "门诊与费用月报", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "门诊人次", exact: true })).toBeVisible();
}
async function minimum(page: Page, value: string) {
  await page.getByRole("textbox", { name: "最少人次", exact: true }).fill(value);
}
test("中心游标分页、筛选、旧快照与仅定义报表", async ({ page }) => {
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().includes("/execute") && request.method() === "POST") writes++;
  });
  await login(page);
  await expect(page.locator(".report-row")).toHaveCount(20);
  await page.getByRole("button", { name: "加载更多报表" }).click();
  await expect(page.locator(".report-row")).toHaveCount(23);
  await page.getByRole("textbox", { name: "筛选已加载报表" }).fill("历史");
  await expect(page.locator(".report-row")).toHaveCount(1);
  await page.locator(".report-row").click();
  await expect(page.getByText("此报表保留历史结果，尚无可运行的统一定义。")).toBeVisible();
  await expect(page.getByRole("button", { name: "运行报表", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "生成分析说明", exact: true })).toHaveCount(0);
  await page.goto("/reports/report-03");
  await expect(page.getByRole("heading", { name: "尚无已保存的结果" })).toBeVisible();
  expect(writes).toBe(0);
});
test("固定版本运行、来源映射、重复回执与刷新恢复", async ({ page }) => {
  await openReport(page);
  await page.getByRole("combobox", { name: "报表内容", exact: true }).press("Enter");
  await page.getByRole("option", { name: "费用合计", exact: true }).click();
  await expect(
    page
      .locator(".report-block")
      .filter({ has: page.getByRole("heading", { name: "费用合计", exact: true }) }),
  ).toContainText("10000");
  await page.getByText(/切换版本/, { exact: false }).click();
  await page.getByRole("combobox", { name: "执行定义版本", exact: true }).press("Enter");
  await page.getByRole("option", { name: "定义 v1", exact: true }).click();
  await expect(page.locator(".report-result-heading")).toContainText("来自定义 v2");
  await minimum(page, "0");
  const bodies: unknown[] = [];
  await page.route("**/reports/*/execute", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect(page.getByText("执行结果尚未确认", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试运行", exact: true }).click();
  await expect(page).toHaveURL(/execution=/);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  await expect(page.locator(".report-result-heading")).toContainText("来自定义 v1");
  const url = page.url();
  await page.reload();
  await expect(page.locator(".report-result-heading")).toContainText("来自定义 v1");
  expect(page.url()).toBe(url);
  expect(bodies).toHaveLength(2);
  await page.getByText("本次结果的实际条件", { exact: true }).click();
  await expect(page.locator(".report-actual-parameters")).toContainText("false");
  await page.getByRole("button", { name: "结果历史", exact: true }).click();
  await page.getByRole("button", { name: /^结果 v1 / }).click();
  await expect(page.getByRole("heading", { name: "结果 v1", exact: true })).toBeVisible();
});
test("执行失败保留原结果，权限收窄清除数据", async ({ page }) => {
  await openReport(page);
  const heading = await page.locator(".report-result-heading h2").textContent();
  await minimum(page, "999");
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect(page.getByText("本次运行失败", { exact: true })).toBeVisible();
  await expect(page.locator(".report-result-heading h2")).toHaveText(heading!);
  await page.route(/\/report-executions\/[^/?]+$/, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        code: "UNAUTHORIZED",
        message: "报表数据权限已变更",
        request_id: "report-denied",
      }),
    }),
  );
  await page.getByRole("button", { name: "刷新执行状态", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("报表数据权限已变更");
  await expect(page.getByRole("heading", { name: "门诊人次", exact: true })).toHaveCount(0);
});
test("AI 说明澄清、完成读取、停止与历史切换", async ({ page }) => {
  await openReport(page);
  const cursors: string[] = [];
  await page.route("**/analysis-runs/*/events", async (route) => {
    cursors.push(route.request().headers()["last-event-id"] ?? "");
    if (cursors.length !== 1) return route.continue();
    // 只读取真实流的第一帧后断开，澄清流会等待用户回答而保持连接。
    const response = await fetch(route.request().url(), { headers: route.request().headers() });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      while (!body.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: body.split("\n\n")[0] + "\n\n",
    });
  });
  await page.getByRole("button", { name: "AI 分析", exact: true }).click();
  await page.getByRole("textbox", { name: "分析说明要求" }).fill("需要澄清的分析说明");
  await page.getByRole("button", { name: "生成分析说明", exact: true }).click();
  await expect(page.getByRole("heading", { name: "补充分析条件" })).toBeVisible();
  expect(cursors.slice(0, 2)).toEqual(["0", "1"]);
  await page.reload();
  await page.getByRole("button", { name: "AI 分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "补充分析条件" })).toBeVisible();
  await page.getByRole("button", { name: "本年", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本次报表分析", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "分析说明要求" }).fill("慢速分析说明");
  await page.getByRole("button", { name: "生成分析说明", exact: true }).click();
  await page.getByRole("button", { name: "停止说明生成", exact: true }).click();
  await expect(page.getByText("已停止说明生成", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "结果历史", exact: true }).click();
  await page.getByRole("button", { name: /^结果 v1 / }).click();
  await expect(page.getByRole("heading", { name: "本次报表分析", exact: true })).toHaveCount(0);
});
test("执行可超过通用 20 秒等待", async ({ page }) => {
  test.setTimeout(60_000);
  await openReport(page);
  await minimum(page, "88");
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect(page.getByText("运行完成", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/execution=/);
});
test("空列表与读取错误可恢复，空结果与五千行分页只读", async ({ page }) => {
  await page.route("**/api/reports?limit=20", (route) => route.fulfill({ json: { items: [] } }));
  await login(page);
  await expect(page.getByRole("heading", { name: "还没有可查看的报表" })).toBeVisible();
  await page.unroute("**/api/reports?limit=20");
  await page.goto("/reports/report-04");
  await expect(page.getByText("已显示 5,000 行", { exact: true })).toBeVisible();
  let queries = 0;
  page.on("request", (request) => {
    if (request.url().includes("/execute")) queries++;
  });
  await page.getByRole("button", { name: "下一页" }).click();
  expect(queries).toBe(0);
  await page.goto("/reports/report-01");
  await page.getByRole("combobox", { name: "报表内容", exact: true }).press("Enter");
  await page.getByRole("option", { name: "科室分布", exact: true }).click();
  await minimum(page, "100");
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect(page.getByText("当前结果没有可绘制的数据", { exact: true })).toBeVisible();
});
test("四套亮暗配色、三档宽度与键盘操作", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openReport(page);
  await page.getByRole("button", { name: "结果历史", exact: true }).click();
  await page.getByRole("button", { name: /^结果 v2 / }).click();
  await expect(page.getByText("已显示 6 行", { exact: true }).first()).toBeVisible();
  for (const mode of ["亮色", "暗色"])
    for (const palette of ["橄榄绿", "海蓝", "青绿", "紫罗兰"]) {
      await page.getByRole("button", { name: "外观设置" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: palette, exact: true }).click();
      await page.getByRole("button", { name: "外观设置" }).click();
      await expect(page.locator(".appearance-panel")).not.toBeVisible();
      await page.screenshot({ path: `${evidence}/report-${mode}-${palette}.png`, fullPage: true });
    }
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${evidence}/report-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "运行条件", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "运行条件", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "运行条件", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("退出和换号后旧执行及说明不会残留", async ({ page }) => {
  await openReport(page);
  await page.getByRole("button", { name: "运行报表", exact: true }).click();
  await expect(page).toHaveURL(/execution=/);
  const url = page.url();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await login(page, "admin");
  await page.goto(url);
  await expect(page.getByRole("alert")).toContainText("执行不存在");
  await expect(page.locator(".report-block")).toHaveCount(0);
  await expect(page.locator(".saved-narrative")).toHaveCount(0);
});
