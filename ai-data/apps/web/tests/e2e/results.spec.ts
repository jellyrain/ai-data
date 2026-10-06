import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** 合成数据容量观测，仅用于共享表格，不代表分析证据 API 的行数上限。 */
type CapacityRecord = {
  count: number;
  columns: number;
  bytes: number;
  renderMilliseconds: number;
  renderedRows: number;
  heapBefore: number | null;
  heapAfter: number | null;
  longTasks: { start: number; duration: number }[];
};
/** 测试页面公开的本地观测入口。 */
type CapacityWindow = Window & {
  capacityProbe: {
    render: (count: number, wide?: boolean) => Promise<CapacityRecord>;
    release: () => number;
  };
};
const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第4步验收/", import.meta.url));
test("千行至十万行本地分页、虚拟节点、宽表与释放", async ({ page }) => {
  await page.goto("/tests/support/result-capacity.html");
  await expect(page.getByRole("heading", { name: "结果组件容量验收" })).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as CapacityWindow).capacityProbe);
  const records: CapacityRecord[] = [];
  for (const count of [1000, 10000, 50000, 100000]) {
    const record = await page.evaluate(
      (value) => (window as unknown as CapacityWindow).capacityProbe.render(value),
      count,
    );
    records.push(record);
    expect(record.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(record.renderedRows).toBeLessThan(30);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByRole("cell", { name: "科室 101", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "上一页", exact: true }).click();
  }
  await page.screenshot({ path: `${evidence}/result-100000.png`, fullPage: true });
  records.push(
    await page.evaluate(() =>
      (window as unknown as CapacityWindow).capacityProbe.render(1000, true),
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/result-wide-mobile.png`, fullPage: true });
  expect(
    await page.evaluate(() => (window as unknown as CapacityWindow).capacityProbe.release()),
  ).toBe(0);
  await mkdir(evidence, { recursive: true });
  await writeFile(
    `${evidence}/result-capacity.json`,
    JSON.stringify(
      {
        browser: "Chromium",
        measured: records,
        note: "单次本机测量；renderMilliseconds 从赋值到两帧，不含数据生成和网络；heap 是浏览器估算，未强制 GC；longTasks 不包括开始前任务。",
      },
      null,
      2,
    ),
  );
});
