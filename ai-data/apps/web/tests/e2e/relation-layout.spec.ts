import { test, expect, type Locator } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { apiDatasetConfigSchema, type CatalogRelation } from "@ai-data/contracts";
import { managementFixture } from "../support/management-fixture";

const evidence = fileURLToPath(
  new URL("../../../../../任务交接/关系布局方向验收/", import.meta.url),
);
const report = "table.dbo.cv_report";
const process = "table.dbo.cv_process_record";
const main = "table.dbo.cv_report_main";
const relations: CatalogRelation[] = [process, main].map((target, index) => ({
  source_id: "clinical",
  object_id: report,
  target_object_id: target,
  relation_id: `relation_${index}`,
  description: index ? "报告关联主数据" : "报告关联闭环记录",
  column_pairs: [{ source_column: "id", target_column: "id" }],
  allowed_join_types: ["inner"],
  enabled: true,
  version: 1,
  updated_at: "2026-10-10 10:00:00",
}));

async function expectLeftToRight(surface: Locator, source: string, target: string) {
  await expect
    .poll(async () => {
      const from = await surface.locator(`.vue-flow__node[data-id="${source}"]`).boundingBox();
      const to = await surface.locator(`.vue-flow__node[data-id="${target}"]`).boundingBox();
      return from && to ? to.x - from.x - from.width : -1;
    })
    .toBeGreaterThan(10);
}

for (const current of [report, process]) {
  test(`从 ${current} 进入时预览和编辑均按源左目标右排列`, async ({ page }) => {
    const fixture = await managementFixture(page);
    const original = fixture.datasets[0];
    fixture.datasets.splice(
      0,
      fixture.datasets.length,
      ...[report, process, main].map((id) => ({
        ...original,
        object_id: id,
        name: id,
      })),
    );
    await page.route("**/admin/catalog/datasets/clinical/*", (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      return route.fulfill({
        json: {
          dataset: fixture.datasets.find((item) => item.object_id === id),
          config: apiDatasetConfigSchema.parse({ source_id: "clinical", object_id: id }),
          config_version: 1,
        },
      });
    });
    await page.route("**/admin/catalog/clinical/objects/*/relations", (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
      return route.fulfill({
        json: {
          source_id: "clinical",
          object_id: id,
          outgoing: relations.filter((row) => row.object_id === id),
          incoming: relations.filter((row) => row.target_object_id === id),
        },
      });
    });
    await page.goto("/settings/data");
    await page.getByLabel("用户名", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
    await page.getByRole("button", { name: "登录工作台" }).click();
    await page.getByRole("button", { name: "业务目录与关系", exact: true }).click();
    await page.getByRole("combobox", { name: "业务数据源" }).click();
    await page.getByRole("option", { name: "clinical · healthy" }).click();
    await page
      .getByLabel("资源列表", { exact: true })
      .getByRole("button")
      .filter({ has: page.getByText(current, { exact: true }) })
      .click();
    await page.locator("summary").filter({ hasText: "业务关系与关联图" }).click();
    const preview = page.getByLabel("已发布关系方向图", { exact: true });
    await preview.scrollIntoViewIfNeeded();
    await expectLeftToRight(preview, report, process);
    if (current === report) await expectLeftToRight(preview, report, main);
    await preview.screenshot({ path: `${evidence}/${current}-预览.png` });
    await page.getByRole("button", { name: "编辑关系画布", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "业务关系画布", exact: true });
    await expectLeftToRight(dialog, report, process);
    if (current === report) await expectLeftToRight(dialog, report, main);
    // 曲线从源对象向右连续前进，端点处不会折返穿过节点。
    for (const path of await dialog.locator(".relation-base").all()) {
      expect(
        await path.evaluate((element) => {
          const curve = element as SVGPathElement;
          const length = curve.getTotalLength();
          const points = Array.from(
            { length: 21 },
            (_, i) => curve.getPointAtLength((length * i) / 20).x,
          );
          return points.every((x, i) => i === 0 || x >= points[i - 1] - 0.1);
        }),
      ).toBe(true);
    }
    await dialog
      .locator(".relation-canvas")
      .screenshot({ path: `${evidence}/${current}-编辑.png` });
    // 手动拖动后，打开和关闭关联配置仍保留该位置。
    const node = dialog.locator(`.vue-flow__node[data-id="${report}"]`);
    const before = (await node.boundingBox())!;
    await node.locator("h3").hover();
    await page.mouse.down();
    await page.mouse.move(before.x + 130, before.y + 220, { steps: 10 });
    await page.mouse.up();
    const moved = (await node.boundingBox())!;
    expect(moved.y - before.y).toBeGreaterThan(50);
    const position = await node.evaluate((element) => (element as HTMLElement).style.transform);
    await dialog.getByRole("button", { name: "编辑关系 报告关联闭环记录", exact: true }).click();
    await page.getByRole("button", { name: "关闭关联设置", exact: true }).click();
    await expect
      .poll(() => node.evaluate((element) => (element as HTMLElement).style.transform))
      .toBe(position);
  });
}
