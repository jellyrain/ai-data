import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第4步验收/", import.meta.url));
async function login(page: Page, username = "analyst") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();
}

test("压缩开始显示整理状态，完成后继续交付结果", async ({ page }) => {
  await login(page);
  let released = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(/\/analysis-runs\/[^/?]+$/, async (route) => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ response, json: released ? state : { ...state, status: "running" } });
  });
  await page.route("**/analysis-runs/*/events", async (route) => {
    if (!first) {
      await pending;
      return route.continue();
    }
    first = false;
    const response = await route.fetch();
    const events = (await response.text()).split("\n\n");
    const completed = events.findIndex(
      (event) => event.includes('"context_compaction"') && event.includes('"completed"'),
    );
    expect(completed).toBeGreaterThan(0);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.slice(0, completed).join("\n\n") + "\n\n",
    });
  });
  try {
    await page.getByRole("textbox", { name: "分析问题" }).fill("验证上下文整理的门诊分析");
    await page.getByRole("button", { name: "发送问题" }).click();
    await expect(page.getByText("正在整理对话上下文…", { exact: true })).toBeVisible();
    await page.screenshot({
      path: fileURLToPath(
        new URL(
          "../../../../../任务交接/上下文按需加载与自动压缩验收/压缩状态.png",
          import.meta.url,
        ),
      ),
      fullPage: true,
    });
    released = true;
    release();
    await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
    await expect(page.getByText("正在整理对话上下文…", { exact: true })).toHaveCount(0);
  } finally {
    released = true;
    release();
  }
});

test("提问、澄清、完整结果、流程图、历史恢复与追问", async ({ page }) => {
  await login(page);
  await page.getByRole("textbox", { name: "分析问题" }).fill("需要澄清的门诊分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("heading", { name: "补充分析条件" })).toBeVisible();
  await page.getByRole("button", { name: "本年", exact: true }).click();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toBeVisible();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await page.locator(".diagram-output").scrollIntoViewIfNeeded();
  await expect(page.locator(".diagram-output svg")).toHaveCount(1);
  await page.getByRole("button", { name: "读取完整已保存结果" }).click();
  await expect(page.getByText("已显示 5,000 行", { exact: true })).toBeVisible();
  await expect(
    page.locator(".evidence-panel").getByText("clinical", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/analysis-light.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toHaveCount(1);
  await page.getByRole("textbox", { name: "分析问题" }).fill("继续分析趋势");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toHaveCount(2);
});

test("中文输入法、停止分析、窄屏与暗色可操作", async ({ page }) => {
  await login(page);
  const input = page.getByRole("textbox", { name: "分析问题" });
  await input.fill("慢速分析");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page).toHaveURL(/\/analysis$/);
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("button", { name: "停止分析" })).toBeVisible();
  await page.getByRole("button", { name: "停止分析" }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  await page.getByRole("button", { name: "打开最近会话" }).click();
  await expect(page.getByRole("dialog", { name: "最近会话" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/analysis-mobile-dark.png`, fullPage: true });
});

test("事件认证刷新与断流按游标恢复，权限收窄清除结果", async ({ page }) => {
  await login(page);
  const cursors: string[] = [];
  let refreshes = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/auth/refresh")) refreshes++;
  });
  await page.route("**/analysis-runs/*/events", async (route) => {
    cursors.push(route.request().headers()["last-event-id"] ?? "");
    if (cursors.length === 1)
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          code: "AUTHENTICATION_FAILED",
          message: "令牌过期",
          request_id: "stream-expired",
        }),
      });
    if (cursors.length === 2) {
      const response = await route.fetch();
      const body = (await response.text()).split("\n\n")[0] + "\n\n";
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    }
    return route.continue();
  });
  await page.getByRole("textbox", { name: "分析问题" }).fill("恢复连接后的门诊分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toHaveCount(1);
  expect(cursors.slice(0, 3)).toEqual(["0", "0", "1"]);
  expect(refreshes).toBe(1);
  await page.route("**/analysis-runs/*/evidence", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        code: "UNAUTHORIZED",
        message: "数据权限已变更",
        request_id: "evidence-denied",
      }),
    }),
  );
  await page.getByRole("button", { name: "读取结果以保存报表 / 查看依据", exact: true }).click();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("数据权限已变更");
  await expect(page.getByRole("button", { name: "发送问题" })).toBeDisabled();
});

test("消息回执丢失后重试复用键，账号切换不能读取他人会话", async ({ page }) => {
  await login(page, "admin");
  const bodies: unknown[] = [];
  await page.route("**/conversations/*/messages", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await page.getByRole("textbox", { name: "分析问题" }).fill("重试同一问题");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("button", { name: "重试发送" })).toBeEnabled();
  await page.getByRole("button", { name: "重试发送" }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  await expect(page.locator(".user-message")).toHaveCount(1);
  const url = page.url();
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "analyst");
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "暂时无法读取这段会话" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toHaveCount(0);
});

test("Agent 空列表和新建回执丢失有明确恢复入口", async ({ page }) => {
  await page.route("**/api/agents", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"items":[]}' }),
  );
  await login(page);
  await expect(page.getByText("暂无可用 Agent，请联系管理员发布并启用配置。")).toBeVisible();
  await page.getByRole("textbox", { name: "分析问题" }).fill("新建响应丢失的分析");
  await expect(page.getByRole("button", { name: "发送问题" })).toBeDisabled();
  await page.unroute("**/api/agents");
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  let creates = 0;
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++;
    await route.fetch();
    return route.abort();
  });
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("button", { name: "已检查，允许再次新建" })).toBeVisible();
  await expect(page.getByRole("link", { name: "新建响应丢失的分析", exact: true })).toBeVisible();
  expect(creates).toBe(1);
});

test("四套明暗配色覆盖内容、代码、图表与 1024px 布局", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.getByRole("textbox", { name: "分析问题" }).fill("主题验收的门诊分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "结果展示方式" }).focus();
  await page.getByRole("combobox", { name: "结果展示方式" }).press("Enter");
  await page.getByRole("option", { name: "柱状图", exact: true }).click();
  await expect
    .poll(async () => ({ canvases: await page.locator(".result-chart canvas").count(), errors }))
    .toEqual({ canvases: 1, errors: [] });
  for (const name of ["折线图", "饼图", "柱状图"]) {
    await page.getByRole("combobox", { name: "结果展示方式" }).focus();
    await page.getByRole("combobox", { name: "结果展示方式" }).press("Enter");
    await page.getByRole("option", { name, exact: true }).click();
    await expect(page.locator(".result-chart canvas")).toHaveCount(1);
  }
  for (const mode of ["亮色", "暗色"])
    for (const [palette, id] of [
      ["橄榄绿", "olive"],
      ["海蓝", "blue"],
      ["青绿", "teal"],
      ["紫罗兰", "violet"],
    ]) {
      await page.getByRole("button", { name: "外观设置" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: palette, exact: true }).click();
      await page.getByRole("button", { name: "外观设置" }).click();
      await expect(page.locator(".appearance-panel")).not.toBeVisible();
      await page.locator(".diagram-output").scrollIntoViewIfNeeded();
      await expect(page.locator(".diagram-output svg")).toHaveCount(1);
      const expectedColor = await page.evaluate(() => {
        const swatch = document.createElement("span");
        swatch.style.color = "var(--app-primary)";
        document.body.append(swatch);
        const color = getComputedStyle(swatch).color;
        swatch.remove();
        return color;
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const node = document.querySelector(".diagram-output .node rect");
            return node ? getComputedStyle(node).stroke : "missing";
          }),
        )
        .toBe(expectedColor);
      await page.screenshot({
        path: `${evidence}/analysis-${mode === "暗色" ? "dark" : "light"}-${id}.png`,
        fullPage: true,
      });
      await page.locator(".result-chart").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${evidence}/chart-${mode === "暗色" ? "dark" : "light"}-${id}.png`,
        fullPage: true,
      });
    }
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("textbox", { name: "分析问题" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/analysis-1024.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("自定义偏好确认遇到并发冲突时重新读取服务端状态", async ({ page }) => {
  await login(page);
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/analysis-runs/*/answers", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fetch();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "CONFLICT", message: "该问题已在另一请求中回答" }),
    });
  });
  await page.getByRole("textbox", { name: "分析问题" }).fill("需要澄清偏好的分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.getByRole("heading", { name: "确认偏好" })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送问题" })).toBeDisabled();
  await page.getByRole("textbox", { name: "自定义回答" }).fill("使用本季度");
  await page.getByRole("button", { name: "提交补充" }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "确认偏好" })).toHaveCount(0);
  expect(submitted).toMatchObject({
    custom_input: "使用本季度",
    clarification_id: expect.any(String),
    idempotency_key: expect.any(String),
  });
});

test("空结果、截断范围与运行失败按服务端内容展示", async ({ page }) => {
  await login(page);
  for (const [question, notice] of [
    ["空结果分析", "查询已返回，当前条件下没有数据。"],
    ["截断分析", "结果已截断，当前行数是已交付量，业务总量未知。"],
    ["失败分析", "分析失败"],
  ]) {
    await page.goto("/analysis");
    await page.getByRole("textbox", { name: "分析问题" }).fill(question!);
    await page.getByRole("button", { name: "发送问题" }).click();
    await expect(page.getByText(notice!, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "停止分析" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "分析问题" }).fill("继续查询");
  await expect(page.getByRole("button", { name: "发送问题" })).toBeEnabled();
});
