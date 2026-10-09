import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../../../../../任务交接/问答全宽与依据收起验收/", import.meta.url),
);
test.use({ video: "off", viewport: { width: 1920, height: 1080 } });
async function start(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByLabel("分析问题", { exact: true }).fill("布局验收：查询今年门诊人次，科室明细");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
}
test("模型正文、表格和输入区使用对话可用宽度", async ({ page }) => {
  await start(page);
  const paragraph = page.locator(".assistant-message:visible .markdown-body > p").first();
  await expect(paragraph).toBeVisible();
  const widths = await paragraph.evaluate((element) => {
    const area = document.querySelector<HTMLElement>(".analysis-messages")!;
    const style = getComputedStyle(area);
    return {
      paragraph: element.getBoundingClientRect().width,
      content: document.querySelector(".analysis-message-content")!.getBoundingClientRect().width,
      table: document.querySelector(".markdown-table")!.getBoundingClientRect().width,
      composer: document.querySelector(".question-form")!.getBoundingClientRect().width,
      available: area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    };
  });
  expect(Math.abs(widths.paragraph - widths.content)).toBeLessThan(2);
  expect(Math.abs(widths.content - widths.available)).toBeLessThan(2);
  expect(Math.abs(widths.table - widths.content)).toBeLessThan(2);
  expect(Math.abs(widths.composer - widths.content)).toBeLessThan(18);
  await page.locator(".analysis-messages").evaluate((element) => {
    element.scrollTop = 0;
  });
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/桌面全宽正文.png` });
});
test("依据默认收起，页头打开最新运行，手动关闭释放空间，重新进入仍收起", async ({ page }) => {
  await start(page);
  const aside = page.locator(".analysis-evidence");
  await expect(aside).not.toBeVisible();
  const closedWidth = (await page.locator(".analysis-main").boundingBox())!.width;
  const conversationUrl = page.url();
  await page.getByRole("button", { name: "打开分析依据", exact: true }).click();
  await expect(aside.locator(".evidence-item")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "收起分析依据", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const openWidth = (await page.locator(".analysis-main").boundingBox())!.width;
  expect(closedWidth - openWidth).toBe(300);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/桌面依据展开.png` });
  await aside.getByRole("button", { name: "关闭分析依据", exact: true }).click();
  await expect(aside).not.toBeVisible();
  expect((await page.locator(".analysis-main").boundingBox())!.width).toBe(closedWidth);
  await page.getByRole("button", { name: "查看分析依据", exact: true }).click();
  await expect(aside.locator(".evidence-item")).toHaveCount(2);
  await page.getByRole("button", { name: "收起分析依据", exact: true }).click();
  await expect(aside).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "打开分析依据", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(aside).not.toBeVisible();
  await page.getByRole("button", { name: "打开分析依据", exact: true }).click();
  await expect(aside.locator(".evidence-item")).toHaveCount(2);
  await page.getByRole("button", { name: "新建分析", exact: true }).click();
  await expect(aside).not.toBeVisible();
  await page.goto(conversationUrl);
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await expect(aside).not.toBeVisible();
});
test("依据在桌面和手机之间切换保持打开，手机支持关闭后再次打开", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  await page.getByRole("button", { name: "打开分析依据", exact: true }).click();
  await expect(page.locator(".analysis-evidence .evidence-item")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = page.getByRole("dialog", { name: "分析依据", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".evidence-item")).toHaveCount(2);
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/手机依据展开.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(drawer).not.toBeVisible();
  await expect(page.locator(".analysis-evidence .evidence-item")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer).toBeVisible();
  await drawer.locator(".el-drawer__close-btn").click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("button", { name: "打开分析依据", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: "打开分析依据", exact: true }).click();
  await expect(drawer.locator(".evidence-item")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
