import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();
}
async function image(page: Page, name: string, color: string, mimeType = "image/png") {
  const data = await page.evaluate(
    ({ color, mimeType }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 120;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 200, 120);
      return canvas.toDataURL(mimeType).split(",")[1]!;
    },
    { color, mimeType },
  );
  return { name, mimeType, buffer: Buffer.from(data, "base64") };
}
test("多图纯图发送、历史恢复、预览和消息回执丢失重试", async ({ page }) => {
  await login(page);
  const files = [
    await image(page, "红色.png", "#ed4545"),
    await image(page, "绿色.png", "#22ac77"),
  ];
  await page.getByLabel("选择图片文件").setInputFiles(files);
  await expect(page.locator(".draft-image")).toHaveCount(2);
  let first = true;
  const bodies: unknown[] = [];
  await page.route("**/conversations/*/messages", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试发送", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "重试发送", exact: true }).click();
  await expect(page.locator(".message-images img")).toHaveCount(2);
  expect(bodies[0]).toEqual(bodies[1]);
  await expect(page.locator(".draft-image")).toHaveCount(0);
  const url = page.url();
  await page.reload();
  await expect(page.locator(".message-images img")).toHaveCount(2);
  await page.locator(".message-images .el-image").first().click();
  await expect(page.locator(".el-image-viewer__wrapper")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".el-image-viewer__wrapper")).toHaveCount(0);
  await page.screenshot({
    path: fileURLToPath(
      new URL("../../../../../任务交接/图片对话验收/图片历史.png", import.meta.url),
    ),
    fullPage: true,
  });
  await expect(page).toHaveURL(url);
});
test("粘贴、拖入、移除、会话草稿和移动端布局", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const file = await image(page, "截图.png", "#2563eb");
  const bytes = Array.from(file.buffer);
  await page.getByRole("textbox", { name: "分析问题" }).evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "截图.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, bytes);
  await expect(page.locator(".draft-image")).toHaveCount(1);
  await page.locator(".question-form").evaluate((element, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "拖入.png", { type: "image/png" }));
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
    );
  }, bytes);
  await expect(page.locator(".draft-image")).toHaveCount(2);
  await page.getByRole("button", { name: "移除图片 截图.png" }).click();
  await expect(page.locator(".draft-image")).toHaveCount(1);
  await page
    .getByLabel("选择图片文件")
    .setInputFiles({ name: "假的.png", mimeType: "image/png", buffer: Buffer.from("bad") });
  await expect(page.getByText("图片无法读取，请选择有效的图片文件", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "分析问题" }).fill("分析截图");
  await expect(page.locator(".draft-image .el-image")).toHaveCSS("width", "80px");
  await expect(page.locator(".draft-image .el-image")).toHaveCSS("height", "64px");
  expect((await page.locator(".draft-image img").boundingBox())!.height).toBeLessThanOrEqual(64);
  await page.screenshot({
    path: fileURLToPath(
      new URL("../../../../../任务交接/图片对话验收/图片输入-390.png", import.meta.url),
    ),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.locator(".message-images img")).toHaveCount(1);
});
test("JPG 和 WebP 上传回执丢失后重试，上传标识保持一致", async ({ page }) => {
  await login(page);
  await page
    .getByLabel("选择图片文件")
    .setInputFiles([
      await image(page, "照片.jpg", "#c27b32", "image/jpeg"),
      await image(page, "图表.webp", "#665ac8", "image/webp"),
    ]);
  await expect(page.locator(".draft-image")).toHaveCount(2);
  const uploads: string[] = [];
  let failed = false;
  await page.route("**/conversations/*/attachments/*", async (route) => {
    uploads.push(route.request().url());
    if (!failed) {
      failed = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByText("上传失败，可重试发送", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.locator(".message-images img")).toHaveCount(2);
  expect(uploads).toHaveLength(3);
  expect(uploads[0]).toBe(uploads[1]);
});
