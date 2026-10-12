import { test, expect, type Page } from "@playwright/test";
import { managementFixture } from "../support/management-fixture";
import { fileURLToPath } from "node:url";
const evidence = fileURLToPath(
  new URL("../../../../../任务交接/关系画布与快捷键验收/", import.meta.url),
);

async function openCanvas(page: Page) {
  await page.goto("/settings/data");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
  await page.getByRole("combobox", { name: "业务数据源" }).click();
  await page.getByRole("option", { name: "clinical · healthy" }).click();
  await page.getByRole("button", { name: /住院记录 visits/ }).click();
  await page.locator("summary").filter({ hasText: "业务关系与关联图" }).click();
  await page.getByRole("button", { name: "编辑关系画布", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "业务关系画布", exact: true })).toBeVisible();
}
async function select(page: Page, label: string, option: string) {
  const input = page.getByRole("combobox", { name: label, exact: true });
  await input.click();
  await page
    .locator(`[id="${await input.getAttribute("aria-controls")}"]`)
    .getByRole("option", { name: option, exact: true })
    .click();
}
async function draftRelation(page: Page) {
  await page.getByRole("button", { name: "添加对象 departments", exact: true }).click();
  await page.getByRole("button", { name: "新建关系", exact: true }).click();
  await select(page, "目标对象", "科室字典 · departments");
  await select(page, "源字段 1", "id");
  await select(page, "目标字段 1", "id");
  await page.getByLabel("关系业务说明", { exact: true }).fill("住院所属科室");
  await page.getByRole("button", { name: "应用修改", exact: true }).click();
}

test("在现有风格画布中建立和编辑多字段关系，统一发布后重新打开", async ({ page }) => {
  const fixture = await managementFixture(page);
  await openCanvas(page);
  await draftRelation(page);
  const dialog = page.getByRole("dialog", { name: "业务关系画布", exact: true });
  await expect(dialog.locator(".relation-base")).toHaveCount(1);
  const node = dialog.locator(".vue-flow__node").first();
  await node.click({ button: "right", position: { x: 40, y: 30 } });
  const menu = dialog.getByRole("menu", { name: "画布操作" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "新建出向关系", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "展开全部关联", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await dialog
    .getByRole("button", { name: "编辑关系 住院所属科室", exact: true })
    .click({ button: "right" });
  await expect(page.getByLabel("关联设置", { exact: true })).toBeHidden();
  await menu.getByRole("menuitem", { name: "编辑关系", exact: true }).click();
  await page.getByRole("button", { name: "添加字段对", exact: true }).click();
  await select(page, "源字段 2", "department_id");
  await select(page, "目标字段 2", "department_id");
  await page.getByRole("button", { name: "应用修改", exact: true }).click();
  await expect(dialog.getByText("待发布 1 项", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发布关系", exact: true }).click();
  await expect(dialog.getByText("关系整批已发布并回读。", { exact: true })).toBeVisible();
  const body = fixture.writes.find((write) => write.path.endsWith("/relations/publish"))!.body;
  expect(body).toMatchObject({
    changes: [
      {
        action: "create",
        object_id: "visits",
        relation: {
          target_object_id: "departments",
          column_pairs: [
            { source_column: "id", target_column: "id" },
            { source_column: "department_id", target_column: "department_id" },
          ],
        },
      },
    ],
  });
  await page.getByRole("button", { name: "返回业务目录", exact: true }).click();
  await page.getByRole("button", { name: "编辑关系画布", exact: true }).click();
  await expect(dialog.locator(".vue-flow__node")).toHaveCount(2);
  await dialog.getByRole("button", { name: "编辑关系 住院所属科室", exact: true }).click();
  await expect(page.locator(".relation-pair").nth(1)).toContainText("department_id");
  await expect(page.getByRole("combobox", { name: "源对象", exact: true })).toBeDisabled();
});

test("发布冲突保留待发布关系并阻止重复发布，离开可继续编辑", async ({ page }) => {
  await managementFixture(page);
  await openCanvas(page);
  await draftRelation(page);
  await page.route("**/clinical/relations/publish", (route) =>
    route.fulfill({
      status: 409,
      json: { code: "CONFLICT", message: "关系版本已变化", request_id: "relation-conflict" },
    }),
  );
  await page.getByRole("button", { name: "发布关系", exact: true }).click();
  await expect(page.getByText(/发布状态需要核对/)).toBeVisible();
  await expect(page.getByRole("button", { name: "发布关系", exact: true })).toBeDisabled();
  await expect(
    page
      .getByRole("dialog", { name: "业务关系画布", exact: true })
      .getByText("待发布 1 项", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回业务目录", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "业务关系画布", exact: true })).toBeVisible();
});

test("表级连接点建立关系后在配置中选择字段，光流及亮暗窄屏保持可用", async ({ page }) => {
  const fixture = await managementFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openCanvas(page);
  const dialog = page.getByRole("dialog", { name: "业务关系画布", exact: true });
  await page.getByRole("button", { name: "添加对象 departments", exact: true }).click();
  await expect(dialog.locator(".vue-flow__node")).toHaveCount(2);
  for (const node of await dialog.locator(".vue-flow__node").all()) {
    await expect(node.locator(".vue-flow__handle.source")).toHaveCount(1);
    await expect(node.locator(".vue-flow__handle.target")).toHaveCount(1);
  }
  await dialog.getByRole("button", { name: "适应画布", exact: true }).click();
  const start = dialog.getByLabel("visits 连接起点", { exact: true });
  const end = dialog.getByLabel("departments 连接终点", { exact: true });
  await start.hover();
  const target = (await end.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByLabel("关联设置", { exact: true })).toBeVisible();
  await expect(dialog.locator(".relation-state-preview .relation-base")).toBeVisible();
  await expect(dialog.getByText("待配置关系 · 待应用", { exact: true })).toBeVisible();
  expect(fixture.writes.filter((write) => write.path.endsWith("/relations/publish"))).toHaveLength(
    0,
  );
  await expect(page.locator(".relation-pair").first()).toContainText("源字段");
  await expect(page.locator(".relation-pair").first()).toContainText("目标字段");
  await select(page, "源字段 1", "department_id");
  await select(page, "目标字段 1", "id");
  await page.getByLabel("关系业务说明", { exact: true }).fill("住院科室关联");
  await page.getByRole("button", { name: "应用修改", exact: true }).click();
  await expect(dialog.locator(".relation-state-preview")).toHaveCount(0);
  await expect(dialog.locator(".relation-base")).toHaveCount(1);
  await expect(dialog.locator(".relation-light").first()).toBeVisible();
  await dialog.getByRole("button", { name: "连线动效", exact: true }).click();
  await expect(dialog.locator(".relation-light")).toHaveCount(0);
  await expect(dialog.locator(".relation-base")).toBeVisible();
  await dialog.getByRole("button", { name: "连线动效", exact: true }).click();
  await page.getByRole("button", { name: "发布关系", exact: true }).click();
  await expect(dialog.getByText("关系整批已发布并回读。", { exact: true })).toBeVisible();
  expect(
    fixture.writes.find((write) => write.path.endsWith("/relations/publish"))?.body,
  ).toMatchObject({
    changes: [
      {
        action: "create",
        object_id: "visits",
        relation: {
          target_object_id: "departments",
          column_pairs: [{ source_column: "department_id", target_column: "id" }],
        },
      },
    ],
  });
  await dialog.getByRole("button", { name: "编辑关系 住院科室关联", exact: true }).click();
  await page.screenshot({ path: `${evidence}/关系画布-亮色.png` });
  await page.getByRole("button", { name: "返回业务目录", exact: true }).click();
  await page.getByRole("button", { name: "外观设置", exact: true }).click();
  await page.getByRole("button", { name: "暗色", exact: true }).click();
  await page.getByRole("button", { name: "海蓝", exact: true }).click();
  await page.getByRole("button", { name: "外观设置", exact: true }).press("Escape");
  await expect(page.locator(".appearance-panel")).toBeHidden();
  await page.getByRole("button", { name: "编辑关系画布", exact: true }).click();
  await dialog.getByRole("button", { name: "编辑关系 住院科室关联", exact: true }).click();
  await page.screenshot({ path: `${evidence}/关系画布-暗色.png` });
  await dialog.locator(".relation-canvas").screenshot({ path: `${evidence}/蓝色光流.png` });
  await dialog
    .locator(".vue-flow__node")
    .first()
    .click({ button: "right", position: { x: 40, y: 30 } });
  await expect(dialog.getByRole("menu", { name: "画布操作" })).toBeVisible();
  await page.screenshot({ path: `${evidence}/关系画布-右键菜单.png` });
  await page.keyboard.press("Escape");
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("button", { name: "应用修改", exact: true })).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `${evidence}/关系画布-${width}.png` });
  }
  expect(errors).toEqual([]);
});

test("拖线到空白处选择表，预览随配置显示且取消会撤回", async ({ page }) => {
  const fixture = await managementFixture(page);
  await openCanvas(page);
  const dialog = page.getByRole("dialog", { name: "业务关系画布", exact: true });
  const picker = dialog.getByRole("dialog", { name: "选择关联表", exact: true });
  async function dragToBlank() {
    const bounds = (await dialog.locator(".relation-canvas").boundingBox())!;
    await dialog.getByLabel("visits 连接起点", { exact: true }).hover();
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 70, bounds.y + 160, { steps: 15 });
    await page.mouse.up();
    await expect(picker).toBeVisible();
  }
  await dragToBlank();
  await expect(picker.getByRole("textbox", { name: "搜索关联表" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(dialog.locator(".relation-base")).toHaveCount(0);
  await dragToBlank();
  await picker.getByRole("textbox", { name: "搜索关联表" }).fill("不存在的表");
  await expect(picker.getByText("没有匹配的表或视图。", { exact: true })).toBeVisible();
  await picker.getByRole("textbox", { name: "搜索关联表" }).fill("科室");
  await page.screenshot({ path: `${evidence}/拖线选择关联表.png` });
  await picker
    .getByRole("button", { name: "选择关联表 科室字典 · departments", exact: true })
    .click();
  await expect(picker).toBeHidden();
  await expect(dialog.locator(".vue-flow__node")).toHaveCount(2);
  await expect(dialog.locator(".relation-state-preview .relation-base")).toBeVisible();
  await expect(page.getByLabel("关联设置", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/关系配置即时连线.png` });
  await page.getByRole("button", { name: "关闭关联设置", exact: true }).click();
  await expect(dialog.locator(".relation-base")).toHaveCount(0);
  await expect(dialog.locator(".vue-flow__node")).toHaveCount(1);
  expect(fixture.writes.filter((write) => write.path.endsWith("/relations/publish"))).toHaveLength(
    0,
  );
  await dragToBlank();
  await picker
    .getByRole("button", { name: "选择关联表 科室字典 · departments", exact: true })
    .click();
  await page.getByLabel("关系业务说明", { exact: true }).fill("科室归属");
  await select(page, "源字段 1", "department_id");
  await select(page, "目标字段 1", "id");
  await page.getByRole("button", { name: "应用修改", exact: true }).click();
  await expect(dialog.locator(".relation-state-preview")).toHaveCount(0);
  await expect(dialog.locator(".relation-base")).toHaveCount(1);
  await expect(dialog.getByText("待发布 1 项", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发布关系", exact: true }).click();
  await expect(dialog.getByText("关系整批已发布并回读。", { exact: true })).toBeVisible();
});

test("编辑入向关系仍提交原源对象和版本，停用在发布后生效", async ({ page }) => {
  const fixture = await managementFixture(page);
  const incoming = {
    source_id: "clinical",
    object_id: "departments",
    relation_id: "members",
    target_object_id: "visits",
    description: "科室包含住院记录",
    column_pairs: [{ source_column: "id", target_column: "department_id" }],
    allowed_join_types: ["left"],
    version: 7,
    enabled: true,
    updated_at: "2026-10-09 10:00:00",
  };
  await page.route("**/objects/visits/relations", (route) =>
    route.fulfill({
      json: { source_id: "clinical", object_id: "visits", outgoing: [], incoming: [incoming] },
    }),
  );
  await openCanvas(page);
  const dialog = page.getByRole("dialog", { name: "业务关系画布", exact: true });
  await dialog.getByRole("button", { name: "编辑关系 科室包含住院记录", exact: true }).click();
  await page.getByLabel("关系业务说明", { exact: true }).fill("科室归属范围");
  await page.getByRole("button", { name: "应用修改", exact: true }).click();
  await page.getByRole("button", { name: "发布关系", exact: true }).click();
  await expect(dialog.getByText("关系整批已发布并回读。", { exact: true })).toBeVisible();
  expect(
    fixture.writes.find((write) => write.path.endsWith("/relations/publish"))!.body,
  ).toMatchObject({
    changes: [
      {
        action: "update",
        object_id: "departments",
        expected_version: 7,
        relation: {
          target_object_id: "visits",
          relation_id: "members",
          description: "科室归属范围",
        },
      },
    ],
  });
  await page.unroute("**/objects/visits/relations");
  await page.getByRole("button", { name: "返回业务目录", exact: true }).click();
  await page.getByRole("button", { name: "编辑关系画布", exact: true }).click();
  await dialog.getByRole("button", { name: "编辑关系 科室归属范围", exact: true }).click();
  await page.getByRole("button", { name: "停用关系", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  expect(fixture.writes.filter((write) => write.path.endsWith("/relations/publish"))).toHaveLength(
    1,
  );
  await page.getByRole("button", { name: "发布关系", exact: true }).click();
  await expect(dialog.getByText("关系整批已发布并回读。", { exact: true })).toBeVisible();
  expect(
    fixture.writes.filter((write) => write.path.endsWith("/relations/publish")).at(-1)!.body,
  ).toMatchObject({
    changes: [
      { action: "disable", object_id: "departments", relation_id: "members", expected_version: 1 },
    ],
  });
  await expect(dialog.locator(".relation-state-disabled")).toHaveCount(1);
});
