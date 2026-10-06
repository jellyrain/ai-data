import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ReportDefinitionVersion } from "@ai-data/contracts";

function graphDefinition(count: number) {
  const record: ReportDefinitionVersion = {
    report_id: "report",
    version: 1,
    user_id: "test-editor",
    organization_id: "test-organization",
    created_at: "2026-09-28 08:00:00",
    shared_with: [],
    definition: {
      title: "科室查询关系",
      parameters: [],
      queries: [
        {
          query_id: "visits",
          query: {
            type: "relational_query",
            source_id: "clinical",
            from: { object_id: "visits", alias: "v" },
            select: [{ field: "v.department" }],
            joins: [],
            filters: { logic: "and", items: [] },
            group_by: [],
            order_by: [],
          },
          bindings: [],
        },
      ],
      presentation: [
        {
          section_id: "main",
          title: "业务概览",
          blocks: [{ block_id: "table", type: "table", title: "科室明细", query_ids: ["visits"] }],
        },
      ],
      block_references: [],
    },
  };
  const query = record.definition.queries[0]!.query;
  if (query.type !== "relational_query") throw new Error("需要关系查询");
  query.source_id = "clinical";
  query.joins = Array.from({ length: count }, (_, i) => ({
    type: "left",
    object_id: "department",
    alias: `d${i}`,
    source_alias: i ? `d${i - 1}` : "v",
    relation_id: "department",
  }));
  return record;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("editor");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page).toHaveURL(/analysis/);
}

test("从中心新建报表，表单与画布切换保留草稿", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("editor");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("link", { name: "报表中心", exact: true }).click();
  await page.getByRole("button", { name: "新建报表", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/new/);
  await page.getByRole("textbox", { name: "报表标题", exact: true }).fill("科室就诊情况");
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  await expect(page.locator(".report-canvas")).toBeVisible();
  await page.getByRole("button", { name: "数据与展示", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "报表标题", exact: true })).toHaveValue(
    "科室就诊情况",
  );
});
test("编辑标识符允许完整输入，失焦后同步查询和参数引用", async ({ page }) => {
  await login(page);
  await page.route("**/reports/report/definition", (route) =>
    route.fulfill({ json: graphDefinition(1) }),
  );
  await page.goto("/reports/report/edit");
  await page.getByText("数据查询与聚合设置", { exact: true }).click();
  await page.getByLabel("查询标识", { exact: true }).fill("department_visits");
  await page.getByLabel("查询标识", { exact: true }).press("Tab");
  await expect(page.getByLabel("查询标识", { exact: true })).toHaveValue("department_visits");
  await page.getByLabel("对象别名", { exact: true }).fill("visit");
  await page.getByLabel("对象别名", { exact: true }).press("Tab");
  await expect(page.getByLabel("对象别名", { exact: true })).toHaveValue("visit");
  await page.getByRole("button", { name: "筛选条件", exact: true }).click();
  await page.getByRole("button", { name: "添加条件", exact: true }).click();
  await page.getByText("高级设置", { exact: true }).click();
  await page.getByLabel("参数标识1", { exact: true }).fill("department");
  await page.getByLabel("参数标识1", { exact: true }).press("Tab");
  await expect(page.getByLabel("参数标识1", { exact: true })).toHaveValue("department");
});
test("离开时保存草稿到原报表后继续目标页面，关闭确认保留编辑", async ({ page }) => {
  await login(page);
  await page.goto("/reports/report-03/edit");
  await page.getByLabel("报表标题", { exact: true }).fill("离开保存验收");
  await page.getByRole("link", { name: "返回报表中心" }).click();
  await page.getByRole("button", { name: "保存并离开", exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
});
test("AI 请求待确认时选择继续查看留在编辑页", async ({ page }) => {
  await login(page);
  await page.goto("/reports/report-03/edit");
  await page.route("**/reports/report-03/revisions", (route) =>
    route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR", message: "响应中断" } }),
  );
  await page.getByRole("button", { name: "AI 修改", exact: true }).click();
  await page.getByLabel("AI 修改要求", { exact: true }).fill("修改标题");
  await page.getByRole("button", { name: "发送 AI 修改", exact: true }).click();
  await expect(page.getByText("请求结果待确认，重试会复用原修改要求与操作键。")).toBeVisible();
  await page.getByRole("button", { name: "收起 AI 修改", exact: true }).click();
  await page.getByRole("button", { name: "AI 修改", exact: true }).click();
  await expect(page.getByLabel("AI 修改要求", { exact: true })).toHaveValue("修改标题");
  await expect(page.getByRole("button", { name: "重试 AI 修改", exact: true })).toBeEnabled();
  await page.getByRole("link", { name: "返回报表中心" }).click();
  await page.getByRole("button", { name: "继续查看", exact: true }).click();
  await expect(page).toHaveURL(/\/edit$/);
});
test("刷新含未核对修订的链接保持锁定，不能再次发送 AI 修改", async ({ page }) => {
  await login(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/revisions"))
      writes.push(request.url());
  });
  await page.goto("/reports/report-03/edit?revision=unverified-run");
  await expect(page.getByRole("alert")).toContainText("报表修改任务不存在");
  await expect(page.getByLabel("报表标题", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("AI 修改要求", { exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
});
test("AI 修改刷新恢复澄清与完成版本，恢复不重复提交", async ({ page }) => {
  await login(page);
  let creates = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/revisions")) creates++;
  });
  await page.goto("/reports/report-06/edit");
  await page.getByRole("button", { name: "AI 修改", exact: true }).click();
  await page.getByLabel("AI 修改要求", { exact: true }).fill("需要澄清后修改标题");
  await page.getByRole("button", { name: "发送 AI 修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "补充分析条件" })).toBeVisible();
  const url = page.url();
  await page.reload();
  await expect(page.getByRole("heading", { name: "补充分析条件" })).toBeVisible();
  await expect(page.getByLabel("报表标题", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "本年", exact: true }).click();
  await expect(page.locator(".revision-progress")).toContainText("已保存版本 3");
  await expect(page.getByLabel("报表标题", { exact: true })).toHaveValue("AI 修改后的报表");
  await page.reload();
  await expect(page.locator(".revision-progress")).toContainText("已保存版本 3");
  await expect(page.getByLabel("报表标题", { exact: true })).toBeEnabled();
  expect(page.url()).toBe(url);
  expect(creates).toBe(1);
  await page.screenshot({
    path: "../../../任务交接/前端第6步验收/AI恢复-完成.png",
    fullPage: true,
  });
});
test("运行中刷新仍可停止，失败刷新保留定义，绑定读取错误可重试", async ({ page }) => {
  await login(page);
  await page.goto("/reports/report-07/edit");
  await expect(page.getByLabel("报表标题", { exact: true })).toBeEnabled();
  const original = await page.getByLabel("报表标题", { exact: true }).inputValue();
  await page.getByRole("button", { name: "AI 修改", exact: true }).click();
  await page.getByLabel("AI 修改要求", { exact: true }).fill("慢速修改");
  await page.getByRole("button", { name: "发送 AI 修改", exact: true }).click();
  await expect(page).toHaveURL(/revision=/);
  let bindingReads = 0;
  await page.route("**/reports/report-07/revisions/*", (route) =>
    ++bindingReads === 1
      ? route.fulfill({
          status: 503,
          json: { code: "INTERNAL_ERROR", message: "恢复读取暂时失败" },
        })
      : route.continue(),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("恢复读取暂时失败");
  await page.getByRole("button", { name: "重新恢复", exact: true }).click();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.locator(".revision-progress")).toContainText("修改已停止");
  await page.reload();
  await expect(page.locator(".revision-progress")).toContainText("修改已停止");
  await expect(page.getByLabel("报表标题", { exact: true })).toHaveValue(original);
  await page.getByLabel("AI 修改要求", { exact: true }).fill("模拟失败修改");
  await page.getByRole("button", { name: "发送 AI 修改", exact: true }).click();
  await expect(page.locator(".revision-progress")).toContainText("修改失败");
  await page.reload();
  await expect(page.locator(".revision-progress")).toContainText("修改失败");
  await expect(page.getByLabel("报表标题", { exact: true })).toHaveValue(original);
  await expect(page.getByLabel("报表标题", { exact: true })).toBeEnabled();
});
test("展示预览可读取标明版本的历史结果，整个过程不执行查询", async ({ page }) => {
  await login(page);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && !request.url().includes("/auth/"))
      mutations.push(request.url());
  });
  await page.goto("/reports/report-01/edit");
  await expect(page.getByText(/使用上次保存结果 · 结果 v/)).toBeVisible();
  await expect(page.getByText("已显示 6 行", { exact: true }).first()).toBeVisible();
  expect(mutations).toEqual([]);
});

test("画布主题、窄屏、键盘入口和离开时恢复导航", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.route("**/reports/report/definition", (route) =>
    route.fulfill({ json: graphDefinition(1) }),
  );
  await page.goto("/reports/report/edit");
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  await expect(page.locator(".query-node")).toHaveCount(2);
  await page.getByRole("button", { name: "适应画布" }).click();
  for (const mode of ["亮色", "暗色"])
    for (const palette of ["橄榄绿", "海蓝", "青绿", "紫罗兰"]) {
      await page.getByRole("button", { name: "外观设置" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: palette, exact: true }).click();
      await page.getByRole("button", { name: "外观设置" }).click();
      await expect(page.locator(".appearance-panel")).not.toBeVisible();
      await page.screenshot({
        path: `../../../任务交接/前端第6步验收/画布-${mode}-${palette}.png`,
      });
    }
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "适应画布" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "打开查询属性" }).click();
    await expect(page.locator(".canvas-inspector")).toBeVisible();
    await page.getByRole("button", { name: "关闭属性面板" }).click();
    await page.screenshot({ path: `../../../任务交接/前端第6步验收/画布-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "关联 v", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "选择批准关系" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "关联 v", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "数据与展示", exact: true }).click();
  await expect(page.locator(".desktop-sidebar")).toBeVisible();
  expect(errors).toEqual([]);
});

test("单查询51个节点和50条关系可以选择与缩放，隐藏页面暂停流光", async ({ page }) => {
  await login(page);
  await page.route("**/reports/report/definition", (route) =>
    route.fulfill({ json: graphDefinition(50) }),
  );
  await page.goto("/reports/report/edit");
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  await expect(page.locator(".query-node")).toHaveCount(51);
  await expect(page.locator(".relation-base")).toHaveCount(50);
  await page.getByRole("button", { name: "放大画布" }).click();
  await page.getByRole("button", { name: "打开查询属性" }).click();
  await expect(page.getByLabel("查询标识", { exact: true })).toHaveValue("visits");
  await page.getByRole("button", { name: "关闭属性面板" }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".flowing-edge.paused")).toHaveCount(50);
  await expect(page.locator(".relation-light").first()).toHaveCSS("animation-play-state", "paused");
});

test("添加批准关系、流光方向与布局保存，重新打开保持定义和坐标", async ({ page }) => {
  await login(page);
  await page.goto("/reports/new");
  await page.getByLabel("报表标题", { exact: true }).fill("就诊关系验收");
  await page.getByRole("button", { name: "添加查询", exact: true }).click();
  await page.getByRole("combobox", { name: "选择数据源", exact: true }).click();
  await page.getByRole("option", { name: "clinical", exact: true }).click();
  await page.getByRole("button", { name: /门诊记录.*visits/ }).click();
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  const sourceHandle = page.locator(".vue-flow__handle.source");
  await sourceHandle.hover();
  const port = await sourceHandle.boundingBox();
  await page.mouse.down();
  await page.mouse.move(port!.x + 180, port!.y + 160, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: "选择批准关系" })).toBeVisible();
  await page.getByRole("button", { name: /就诊科室/ }).click();
  await page.getByRole("button", { name: "添加关联对象", exact: true }).click();
  await page.getByRole("button", { name: "关闭属性面板" }).click();
  await expect(page.locator(".query-node")).toHaveCount(2);
  await expect(page.locator(".relation-base")).toHaveCount(1);
  const light = page.locator(".relation-light").first();
  const offset = await light.evaluate((el) => getComputedStyle(el).strokeDashoffset);
  await expect
    .poll(() => light.evaluate((el) => getComputedStyle(el).strokeDashoffset))
    .not.toBe(offset);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(light).toBeHidden();
  await expect(page.locator(".relation-base")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const node = page.locator(".query-node").first();
  const position = await node.boundingBox();
  await page.mouse.move(position!.x + 70, position!.y + 50);
  await page.mouse.down();
  await page.mouse.move(position!.x + 120, position!.y + 100, { steps: 8 });
  await page.mouse.up();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/report-definitions") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const record = await (await saved).json();
  expect(record.definition.queries[0].query.joins[0]).toMatchObject({
    source_alias: "t",
    type: "left",
    relation_id: "department",
  });
  expect(record.definition.editor_layout.nodes).toHaveLength(1);
  await expect(page).toHaveURL(/\/reports\/[^/]+\/edit/);
  await page.reload();
  await page.getByRole("button", { name: "数据编排", exact: true }).click();
  await expect(page.locator(".query-node")).toHaveCount(2);
  const transform = page.locator(".vue-flow__node").first();
  await expect(transform).toHaveAttribute(
    "style",
    new RegExp(
      `translate\\(${record.definition.editor_layout.nodes[0].x}px, ${record.definition.editor_layout.nodes[0].y}px\\)`,
    ),
  );
  await page.screenshot({ path: "../../../任务交接/前端第6步验收/画布亮色.png" });
});
