import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { knowledgeFixture } from "../support/knowledge-fixture";
import { knowledgeCandidateSchema } from "@ai-data/contracts";

const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第10步验收/", import.meta.url));
async function login(page: Page, path: string, user = "admin") {
  await page.goto(path);
  await page.getByLabel("用户名", { exact: true }).fill(user);
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page).toHaveURL((url) => url.pathname === path);
}
async function choose(page: Page, label: string, value: string) {
  await page
    .getByRole("combobox", { name: label, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'el-select__wrapper')]")
    .click();
  const controls = await page
    .getByRole("combobox", { name: label, exact: true })
    .getAttribute("aria-controls");
  await page
    .locator(`[id="${controls}"]`)
    .getByRole("option", { name: value, exact: true })
    .click();
}
async function createRule(page: Page) {
  await page.getByRole("button", { name: "提交知识候选", exact: true }).click();
  await page.getByLabel("知识标题", { exact: true }).fill("住院费用统计口径");
  await page
    .getByLabel("知识正文", { exact: true })
    .fill("按出院日期统计，费用按有效记账记录汇总。");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect(page.getByText("候选已保存", { exact: false })).toBeVisible();
}
async function publish(page: Page) {
  await page.getByRole("button", { name: "搜索负责人", exact: true }).click();
  await choose(page, "负责人", "测试管理员 · admin");
  await page.getByRole("button", { name: "分配负责人", exact: true }).click();
  await page.getByLabel("审核意见", { exact: true }).fill("口径核对通过");
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await page.getByLabel("知识生效时间", { exact: true }).fill("2026-10-03 09:00:00");
  await page.getByRole("button", { name: "发布知识", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("heading", { name: "审核记录" })).toBeVisible();
}

test("个人偏好保存、删除后重新设置与未保存离页保护", async ({ page }) => {
  const fixture = await knowledgeFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "/knowledge");
  await page.getByRole("button", { name: "个人偏好", exact: true }).click();
  await page.getByRole("button", { name: "新增偏好", exact: true }).click();
  await page.getByLabel("偏好标识", { exact: true }).fill("default-time");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect(page.getByText("偏好已保存", { exact: false })).toBeVisible();
  expect(fixture.preferences.get("default-time")?.value).toMatchObject({
    type: "time_range",
    range: { period: "this_year" },
  });
  await choose(page, "时间周期", "本月");
  await page.getByRole("button", { name: "企业知识", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect.poll(() => fixture.preferences.get("default-time")?.version).toBe(2);
  await page.getByRole("button", { name: "删除偏好", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("偏好已删除。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新增偏好", exact: true }).click();
  await page.getByLabel("偏好标识", { exact: true }).fill("default-time");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect.poll(() => fixture.preferences.get("default-time")?.version).toBe(4);
  expect(errors).toEqual([]);
});

test("知识候选分配、固定版本审核发布、停用后管理回读", async ({ page }) => {
  const fixture = await knowledgeFixture(page);
  await login(page, "/settings/knowledge");
  await createRule(page);
  await publish(page);
  expect(fixture.publications).toHaveLength(1);
  await page.getByRole("button", { name: "正式知识管理", exact: true }).click();
  await page.locator(".management-resource").filter({ hasText: "住院费用统计口径" }).click();
  await page.getByRole("button", { name: "停用知识", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("button", { name: "启用知识", exact: true })).toBeVisible();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: evidence + "knowledge-review-light.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("报表固定版本提交为模板，发布后创建个人草稿", async ({ page }) => {
  const fixture = await knowledgeFixture(page);
  await login(page, "/reports/report-01");
  await page.getByRole("button", { name: "提交为组织模板", exact: true }).click();
  await page.getByRole("button", { name: "确认提交模板", exact: true }).click();
  await page.getByRole("link", { name: "查看模板候选", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge\?tab=candidates&candidate=/);
  await expect(page.getByRole("heading", { name: "组织门诊模板", exact: true })).toBeVisible();
  expect(fixture.candidates[0]?.content).toMatchObject({
    type: "report_template",
    definition_version: 2,
  });
  await publish(page);
  await page.getByRole("button", { name: "企业知识", exact: true }).click();
  await page.locator(".management-resource").first().click();
  await page.getByRole("link", { name: "使用模板新建报表", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/new\?template=/);
  await expect(page.getByText("已从模板创建草稿", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible();
});

test("记忆任务失败重试与窄屏、主题适配", async ({ page }) => {
  const fixture = await knowledgeFixture(page);
  await login(page, "/settings/tasks");
  await expect(page.getByText("MODEL_TIMEOUT", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
  expect(fixture.tasks[0]!.status).toBe("pending");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
  }
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("heading", { name: "后台任务", exact: true }).click();
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: evidence + "tasks-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("普通用户可使用个人知识入口，不能进入组织管理页", async ({ page }) => {
  await knowledgeFixture(page);
  await login(page, "/knowledge", "analyst");
  await expect(page.getByRole("button", { name: "待我审核", exact: true })).toBeVisible();
  await page.goto("/settings/knowledge");
  await expect(page).toHaveURL(/\/forbidden$/);
});

test("偏好版本冲突保留草稿，撤权后清理旧内容", async ({ page }) => {
  await knowledgeFixture(page);
  await login(page, "/knowledge");
  await page.getByRole("button", { name: "个人偏好", exact: true }).click();
  await page.getByRole("button", { name: "新增偏好", exact: true }).click();
  await page.getByLabel("偏好标识", { exact: true }).fill("my-time");
  await page.route("**/api/me/preferences/my-time", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "CONFLICT", message: "版本已变化", request_id: "conflict" }),
    }),
  );
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await expect(page.getByRole("button", { name: "核对当前版本", exact: true })).toBeVisible();
  await expect(page.getByLabel("偏好标识", { exact: true })).toHaveValue("my-time");
  await page.route("**/api/me/preferences", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "UNAUTHORIZED", message: "权限已撤回", request_id: "revoked" }),
    }),
  );
  await page.getByRole("button", { name: "刷新偏好", exact: true }).click();
  await expect(page.getByLabel("偏好标识", { exact: true })).toHaveCount(0);
  await expect(page.locator(".management-resource")).toHaveCount(0);
});

test("分类偏好表单保存有类型的条件、分组、指标和查询习惯", async ({ page }) => {
  const fixture = await knowledgeFixture(page);
  await page.route("**/api/metrics", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            metric_id: "visits",
            version: 1,
            name: "门诊人次",
            description: "门诊统计",
            aliases: [],
            grain: "一次门诊",
            deduplication_keys: ["v.id"],
            date_basis: { field: "v.date", data_type: "date" },
            query: {
              type: "relational_query",
              source_id: "clinical",
              from: { object_id: "visits", alias: "v" },
              select: [{ field: "v.id", aggregation: "count_distinct", as: "count" }],
            },
            dimensions: ["v.department"],
            value: { type: "column", column: "count" },
            total_rule: "recalculate",
          },
        ],
      },
    }),
  );
  await login(page, "/knowledge");
  await page.getByRole("button", { name: "个人偏好", exact: true }).click();
  for (const [type, label] of [
    ["metric", "常用指标"],
    ["grouping", "分组"],
    ["filters", "筛选条件"],
    ["presentation", "展示方式"],
    ["query_habit", "查询习惯"],
  ]) {
    await page.getByRole("button", { name: "新增偏好", exact: true }).click();
    await page.getByLabel("偏好标识", { exact: true }).fill("form-" + type);
    await choose(page, "偏好类型", label!);
    if (type === "metric") await choose(page, "常用指标", "门诊人次");
    if (["grouping", "filters", "query_habit"].includes(type!)) {
      await choose(page, "适用数据源", "clinical");
      await choose(page, "适用数据对象", "门诊记录");
      if (type === "grouping" || type === "query_habit") {
        await choose(page, type === "grouping" ? "分组字段" : "习惯分组", "department");
        await page.getByRole("heading", { name: "偏好内容", exact: true }).click();
      }
      if (type === "filters" || type === "query_habit") {
        await page.getByRole("button", { name: "添加筛选条件", exact: true }).click();
        await choose(page, "筛选字段1", "count");
        await choose(page, "筛选值1取值方式", "指定值");
        await page.getByLabel("筛选值1", { exact: true }).fill("10");
        await page.getByLabel("筛选值1", { exact: true }).press("Tab");
      }
    }
    await page.getByRole("button", { name: "保存偏好", exact: true }).click();
    await expect.poll(() => fixture.preferences.get("form-" + type)?.version).toBe(1);
  }
  expect(fixture.preferences.get("form-filters")?.value).toMatchObject({
    conditions: [{ field: "count", value: 10, data_type: "integer" }],
  });
  expect(fixture.preferences.get("form-query_habit")?.value).toMatchObject({
    filters: [{ value: 10 }],
    dimensions: ["department"],
  });
});

test("知识长表单的四配色亮暗模式与三种宽度", async ({ page }) => {
  test.setTimeout(120000);
  await knowledgeFixture(page);
  await login(page, "/knowledge");
  await page.getByRole("button", { name: "个人偏好", exact: true }).click();
  await page.getByRole("button", { name: "新增偏好", exact: true }).click();
  for (const mode of ["亮色", "暗色"])
    for (const [palette, id] of [
      ["橄榄绿", "olive"],
      ["海蓝", "blue"],
      ["青绿", "teal"],
      ["紫罗兰", "violet"],
    ]) {
      await page.getByRole("button", { name: "外观设置" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: palette!, exact: true }).click();
      await page.getByRole("button", { name: "外观设置" }).click();
      await expect(page.locator(".appearance-panel")).toBeHidden();
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
          .toBe(true);
        await page.getByRole("button", { name: "保存偏好", exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByRole("button", { name: "保存偏好", exact: true })).toBeInViewport();
        if (id === "blue" && width !== 1024) {
          await page.getByRole("heading", { name: "知识与偏好", exact: true }).click();
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({
            path: evidence + `preferences-${mode}-${width}.png`,
            fullPage: true,
            animations: "disabled",
          });
        }
      }
    }
});

test("任务来源必须通过原分析运行授权才导航", async ({ page }) => {
  await knowledgeFixture(page);
  await login(page, "/settings/tasks");
  await page.route("**/api/analysis-runs/private-run", (route) =>
    route.fulfill({ status: 403, json: { code: "UNAUTHORIZED", message: "无权读取此运行" } }),
  );
  await page.getByRole("button", { name: "来源会话", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/tasks$/);
  await expect(page.getByRole("alert")).toContainText("无权读取此运行");
});

test("指标候选修改口径保留完整查询，指定负责人从个人入口审核", async ({ page }) => {
  const fixture = await knowledgeFixture(page);
  fixture.candidates.push(
    knowledgeCandidateSchema.parse({
      candidate_id: "metric-review",
      knowledge_id: "visits",
      organization_id: "test-organization",
      version: 1,
      status: "pending",
      created_by: "test-admin",
      owner_id: "test-analyst",
      created_at: "2026-10-03 10:00:00",
      updated_at: "2026-10-03 10:00:00",
      content_hash: "a".repeat(64),
      scope: { source_id: "clinical", object_id: "visits" },
      content: {
        type: "metric",
        definition: {
          metric_id: "visits",
          version: 1,
          name: "门诊指标",
          description: "原统计口径",
          aliases: ["工作量"],
          grain: "一次门诊",
          deduplication_keys: ["v.count"],
          date_basis: { field: "v.date", data_type: "date" },
          query: {
            type: "relational_query",
            source_id: "clinical",
            from: { object_id: "visits", alias: "v" },
            select: [{ field: "v.count", aggregation: "sum", as: "count" }],
          },
          dimensions: ["v.department"],
          value: { type: "column", column: "count" },
          total_rule: "recalculate",
        },
      },
    }),
  );
  await login(page, "/knowledge");
  await page.getByRole("button", { name: "我的候选", exact: true }).click();
  await page.locator(".management-resource").filter({ hasText: "门诊指标" }).click();
  await page.getByRole("button", { name: "修改候选", exact: true }).click();
  const original = structuredClone(fixture.candidates[0]!.content);
  await page.getByLabel("统计口径", { exact: true }).fill("按当前授权科室统计");
  await page.getByRole("button", { name: "保存候选", exact: true }).click();
  await expect.poll(() => fixture.candidates[0]?.version).toBe(2);
  expect(fixture.candidates[0]!.content).toMatchObject({
    ...original,
    ...(original.type === "metric"
      ? { definition: { ...original.definition, description: "按当前授权科室统计" } }
      : {}),
  });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await login(page, "/knowledge", "analyst");
  await page.getByRole("button", { name: "待我审核", exact: true }).click();
  await page.locator(".management-resource").filter({ hasText: "门诊指标" }).click();
  await expect(page.getByRole("button", { name: "分配负责人", exact: true })).toHaveCount(0);
  await page.getByLabel("审核意见", { exact: true }).fill("范围与口径已确认");
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await expect.poll(() => fixture.candidates[0]?.status).toBe("approved");
});
