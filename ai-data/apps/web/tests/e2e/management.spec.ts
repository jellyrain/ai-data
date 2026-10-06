import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { managementFixture } from "../support/management-fixture";
const evidence = fileURLToPath(
  new URL("../../../../../任务交接/前端第8-9步验收/", import.meta.url),
);
async function login(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page).toHaveURL((url) => url.pathname === path);
}
test("模型按版本发布认证与 Agent 固定版本管理", async ({ page }) => {
  const fixture = await managementFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, "/settings/models");
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await page.getByLabel("显示名称", { exact: true }).fill("院内模型第二版");
  await page.getByLabel("API Key", { exact: true }).fill("isolated-fixture-key");
  await page.getByText("已确认本版本的完整认证配置", { exact: true }).click();
  await page.getByRole("button", { name: "发布 v2", exact: true }).click();
  await expect(page.getByRole("heading", { name: "院内模型第二版", exact: true })).toBeVisible();
  expect(fixture.models.at(-1)?.version).toBe(2);
  await page.screenshot({ path: `${evidence}/models-light.png`, fullPage: true });
  await page.goto("/settings/agents");
  await page.getByRole("button", { name: /住院分析助手 clinical/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await page.getByLabel("名称", { exact: true }).fill("住院分析助手第二版");
  await page.getByRole("button", { name: "发布 v2", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "住院分析助手第二版", exact: true }),
  ).toBeVisible();
  expect(fixture.agents.at(-1)?.model_version).toBe(1);
  await page.getByRole("button", { name: "query-dsl · 源文档" }).click();
  await expect(page.getByRole("heading", { name: "查询 DSL", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("用户创建和部门范围保存后回读", async ({ page }) => {
  const fixture = await managementFixture(page);
  await login(page, "/settings/users");
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await page.getByLabel("登录名", { exact: true }).fill("new-doctor");
  await page.getByLabel("显示名称", { exact: true }).fill("住院费用分析员");
  await page.getByLabel("初始密码", { exact: true }).fill("Isolated-test-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "住院费用分析员", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "业务部门 ID" }).fill("D02");
  await page.getByRole("option", { name: "D02", exact: true }).click();
  await page.getByRole("heading", { name: "住院费用分析员", exact: true }).click();
  await page.getByRole("button", { name: "保存部门范围" }).click();
  await expect(page.getByText("业务部门范围已保存并回读。")).toBeVisible();
  expect(fixture.writes.find((write) => write.path.endsWith("/departments"))?.body).toMatchObject({
    department_ids: ["D02"],
    expected_authorization_version: 1,
  });
  await page.screenshot({ path: `${evidence}/users-light.png`, fullPage: true });
});
test("数据源完整回读与白名单逻辑别名保持", async ({ page }) => {
  const fixture = await managementFixture(page);
  await login(page, "/settings/data");
  await page.getByRole("combobox", { name: "DAS 实例" }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
  await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
  await expect(page.getByRole("heading", { name: "数据源配置", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /visits visits 可查询/ }).click();
  await page.getByText("允许查询", { exact: true }).click();
  await page.getByRole("button", { name: "应用对象编辑" }).click();
  await page.getByRole("button", { name: "保存完整白名单" }).click();
  await expect(page.getByText(/完整白名单已保存并回读/)).toBeVisible();
  const saved = fixture.writes.find((write) => write.path.endsWith("/data-source-objects"))?.body;
  expect(saved).toMatchObject({
    objects: [
      {
        object_id: "visits",
        discovered_object_id: "table.dbo.inpatient",
        is_queryable: false,
        query_capabilities: { sortable_fields: [] },
      },
    ],
  });
  await page.screenshot({ path: `${evidence}/data-source-light.png`, fullPage: true });
});
test("Web 保存业务连接参数并回读，原密码保持在服务端", async ({ page }) => {
  const fixture = await managementFixture(page);
  await login(page, "/settings/data");
  await page.getByRole("combobox", { name: "DAS 实例" }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
  await page.getByRole("button", { name: "保存数据库凭据", exact: true }).click();
  const editor = page.getByRole("region", { name: "已有凭据连接参数" });
  await editor.getByRole("combobox", { name: "连接参数凭据" }).click();
  await page.getByRole("option", { name: "demo-ref", exact: true }).click();
  await expect(editor.getByText(/尚未在 Web 设置/)).toBeVisible();
  // 点击可见的开关轨道；隐藏 input 的原生点击会被组件取消默认行为。
  await editor
    .locator(".el-switch")
    .filter({ has: page.getByRole("switch", { name: "信任服务器证书", exact: true }) })
    .locator(".el-switch__core")
    .click();
  await editor.getByRole("button", { name: "保存连接参数", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor.getByText(/连接参数已保存并回读/)).toBeVisible();
  await expect(editor.getByRole("switch", { name: "信任服务器证书", exact: true })).toBeChecked();
  const write = fixture.writes.find((row) => row.path.endsWith("/sqlserver-transport"));
  expect(write?.body).toEqual({
    expected_revision: "1".padStart(64, "0"),
    sqlserver_transport: { encrypt: true, trust_server_certificate: true },
  });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await editor.screenshot({ path: `${evidence}/sqlserver-transport-web.png` });
});
test("连接参数版本冲突保留草稿，读取新基准需确认，权限撤回清理表单", async ({ page }) => {
  await managementFixture(page);
  await login(page, "/settings/data");
  await page.getByRole("combobox", { name: "DAS 实例" }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
  await page.getByRole("button", { name: "保存数据库凭据", exact: true }).click();
  const editor = page.getByRole("region", { name: "已有凭据连接参数" });
  await editor.getByRole("combobox", { name: "连接参数凭据" }).click();
  await page.getByRole("option", { name: "demo-ref", exact: true }).click();
  const trust = editor.getByRole("switch", { name: "信任服务器证书", exact: true });
  await trust.press("Enter");
  await page.route("**/sqlserver-transport", async (route) => {
    if (route.request().method() === "PUT")
      return route.fulfill({
        status: 409,
        json: {
          code: "CONFIGURATION_CONFLICT",
          message: "配置版本已更新",
          request_id: "transport-conflict",
        },
      });
    return route.fallback();
  });
  await editor.getByRole("button", { name: "保存连接参数", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor.getByText(/保存结果需核对/)).toBeVisible();
  await expect(trust).toBeChecked();
  await expect(editor.getByRole("button", { name: "保存连接参数", exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "读取最新参数", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(trust).toBeChecked();
  await page.route("**/sqlserver-transport", async (route) =>
    route.fulfill({
      status: 403,
      json: { code: "UNAUTHORIZED", message: "权限已撤回", request_id: "transport-revoke" },
    }),
  );
  await editor.getByRole("button", { name: "读取最新参数", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(trust).toHaveCount(0);
});
test("连接参数保存回执丢失时先回读确认，不重复提交", async ({ page }) => {
  await managementFixture(page);
  await login(page, "/settings/data");
  await page.getByRole("combobox", { name: "DAS 实例" }).click();
  await page.getByRole("option", { name: "das-demo · 在线" }).click();
  await page.getByRole("button", { name: "保存数据库凭据", exact: true }).click();
  const editor = page.getByRole("region", { name: "已有凭据连接参数" });
  await editor.getByRole("combobox", { name: "连接参数凭据" }).click();
  await page.getByRole("option", { name: "demo-ref", exact: true }).click();
  const trust = editor.getByRole("switch", { name: "信任服务器证书", exact: true });
  await trust.press("Enter");
  let writes = 0;
  await page.route("**/sqlserver-transport", async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      return route.fulfill({
        status: 500,
        json: { code: "INTERNAL_ERROR", message: "保存回执丢失", request_id: "lost-receipt" },
      });
    }
    return route.fulfill({
      json: {
        secret_ref: "demo-ref",
        connector_kind: "sqlserver",
        sqlserver_transport: { encrypt: true, trust_server_certificate: true },
        origin: "credential",
        revision: "2".padStart(64, "0"),
        sources: [],
      },
    });
  });
  await editor.getByRole("button", { name: "保存连接参数", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(editor.getByText("已回读确认连接参数已保存。")).toBeVisible();
  await expect(trust).toBeChecked();
  await expect(editor.getByRole("button", { name: "保存连接参数", exact: true })).toBeDisabled();
  expect(writes).toBe(1);
});
test("业务目录保持空能力，策略保存采用角色实际版本", async ({ page }) => {
  const fixture = await managementFixture(page);
  await login(page, "/settings/data");
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await page.getByRole("combobox", { name: "业务数据源" }).click();
  await page.getByRole("option", { name: "clinical · healthy" }).click();
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await page.getByLabel("业务说明", { exact: true }).fill("更新的住院粒度说明");
  await page.getByRole("button", { name: "保存业务配置" }).click();
  await expect(page.getByText("业务目录配置已保存并回读。")).toBeVisible();
  expect(
    fixture.writes.find((write) => write.path === "/admin/catalog/datasets")?.body,
  ).toMatchObject({
    expected_version: 1,
    query_capabilities: { sortable_fields: [] },
    approved_relations: [],
  });
  await page.goto("/settings/permissions");
  await page.getByRole("combobox", { name: "策略数据源" }).click();
  await page.getByRole("option", { name: "clinical", exact: true }).click();
  await page.getByRole("combobox", { name: "策略角色" }).click();
  await page.getByRole("option", { name: "业务分析员 · analyst" }).click();
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await page.getByRole("button", { name: "保存对象权限", exact: true }).click();
  await expect(page.getByText("规则已保存，当前角色策略版本为 2。")).toBeVisible();
  await page.getByRole("button", { name: "保存对象权限", exact: true }).click();
  await expect(page.getByText("规则已保存，当前角色策略版本为 4。")).toBeVisible();
  expect(
    fixture.writes.filter((write) => write.path === "/admin/catalog/object-permissions").at(-1)
      ?.body,
  ).toMatchObject({ expected_version: 2 });
  await page.screenshot({ path: `${evidence}/permissions-light.png`, fullPage: true });
});
test("管理页面亮暗四配色与 1440、1024、390 宽度", async ({ page }) => {
  await managementFixture(page);
  await login(page, "/settings/models");
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["亮色", "暗色"])
      for (const palette of ["橄榄绿", "海蓝", "青绿", "紫罗兰"]) {
        await page.getByRole("button", { name: "外观设置" }).click();
        await page.getByRole("button", { name: mode, exact: true }).click();
        await page.getByRole("button", { name: palette, exact: true }).click();
        await page.getByRole("button", { name: "外观设置" }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
  }
  await page.getByRole("button", { name: "外观设置" }).press("Escape");
  await expect(page.locator(".appearance-panel")).not.toBeVisible();
  await page.screenshot({ path: `${evidence}/management-mobile-dark.png`, fullPage: true });
});

test("其余管理表单在三种宽度下保持页面内布局", async ({ page }) => {
  test.setTimeout(90000);
  await managementFixture(page);
  await login(page, "/settings/agents");
  for (const path of [
    "/settings/agents",
    "/settings/users",
    "/settings/data",
    "/settings/permissions",
  ]) {
    await page.goto(path);
    if (path.endsWith("agents")) {
      await page.getByRole("button", { name: /住院分析助手 clinical/ }).click();
      await page.getByRole("button", { name: "以此版本为基础发布" }).click();
    } else if (path.endsWith("users")) {
      await page.getByRole("button", { name: /住院业务员 u1/ }).click();
    } else if (path.endsWith("data")) {
      await page.getByRole("combobox", { name: "DAS 实例" }).click();
      await page.getByRole("option", { name: "das-demo · 在线" }).click();
      await page.getByRole("button", { name: /clinical clinical 启用/ }).click();
    } else {
      await page.getByRole("combobox", { name: "策略数据源" }).click();
      await page.getByRole("option", { name: "clinical", exact: true }).click();
      await page.getByRole("combobox", { name: "策略角色" }).click();
      await page.getByRole("option", { name: "业务分析员 · analyst" }).click();
      await page.getByRole("button", { name: /住院记录 visits/ }).click();
    }
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        path + " / " + width,
      ).toBe(true);
    }
  }
});

test("发布关系后两端节点在各宽度下完整可见", async ({ page }) => {
  await managementFixture(page);
  await login(page, "/settings/data");
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await page.getByRole("combobox", { name: "业务数据源" }).click();
  await page.getByRole("option", { name: "clinical · healthy" }).click();
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  const graph = page.getByLabel("已发布关系方向图");
  await expect(graph.locator(".vue-flow__node")).toHaveCount(1);
  await page.getByRole("button", { name: "新建出向关系", exact: true }).click();
  await page.getByLabel("关系标识", { exact: true }).fill("visit_department");
  for (const [label, option] of [
    ["目标对象", "departments"],
    ["源字段 1", "department_id"],
    ["目标字段 1", "id"],
  ]) {
    const select = page.getByRole("combobox", { name: label, exact: true });
    await select.click();
    const listbox = page.locator(`[id="${await select.getAttribute("aria-controls")}"]`);
    await listbox.getByRole("option", { name: option, exact: true }).click();
  }
  await page.getByLabel("业务说明", { exact: true }).last().fill("住院记录所属科室");
  await page.getByRole("button", { name: "加入发布清单", exact: true }).click();
  await page.getByRole("button", { name: "发布整批关系", exact: true }).click();
  await expect(page.getByText("关系整批已发布并回读。", { exact: true })).toBeVisible();
  await expect(graph.locator(".vue-flow__node")).toHaveCount(2);
  for (const width of [1440, 1024, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await graph.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          graph.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return [...element.querySelectorAll(".vue-flow__node")].every((node) => {
              const rect = node.getBoundingClientRect();
              return (
                rect.width > 0 &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom
              );
            });
          }),
        { message: `关系两端完整可见：${width}px` },
      )
      .toBe(true);
  }
  await graph.screenshot({ path: `${evidence}/relations-graph-light.png` });
});

test("发布回执失败保留草稿，离页确认和权限撤回清理秘密", async ({ page }) => {
  await managementFixture(page);
  await login(page, "/settings/models");
  await page.getByRole("button", { name: /院内模型 rj/ }).click();
  await page.getByRole("button", { name: "以此版本为基础发布" }).click();
  await page.getByLabel("显示名称", { exact: true }).fill("待核对的模型");
  await page.getByLabel("API Key", { exact: true }).fill("isolated-receipt-key");
  await page.getByText("已确认本版本的完整认证配置", { exact: true }).click();
  await page.route("**/api/models", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          code: "UPSTREAM_FAILURE",
          message: "回执丢失",
          request_id: "receipt-test",
        }),
      });
    return route.fallback();
  });
  await page.getByRole("button", { name: "发布 v2", exact: true }).click();
  await expect(page.getByText(/发布结果待核对/)).toBeVisible();
  await expect(page.getByLabel("显示名称", { exact: true })).toHaveValue("待核对的模型");
  await expect(page.getByRole("button", { name: "发布 v2", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("isolated-receipt-key");
  await page.route("**/api/models", async (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "FORBIDDEN", message: "权限已撤回", request_id: "revoke-test" }),
    }),
  );
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
  await expect(page.locator(".management-resource")).toHaveCount(0);
});
