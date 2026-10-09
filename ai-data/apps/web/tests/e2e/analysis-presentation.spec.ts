import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../../../../../任务交接/问答显示验收/", import.meta.url));
test.use({ video: "off", reducedMotion: "no-preference" });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "分析问题" })).toBeVisible();
}

async function userAlignment(page: Page) {
  const content = await page.locator(".analysis-message-content").boundingBox();
  const bubble = await page.locator(".user-message .plain-content").last().boundingBox();
  const label = await page.locator(".user-message > strong").last().boundingBox();
  expect(content).not.toBeNull();
  expect(bubble).not.toBeNull();
  expect(label).not.toBeNull();
  expect(Math.abs(bubble!.x + bubble!.width - content!.x - content!.width)).toBeLessThan(2);
  expect(Math.abs(label!.x + label!.width - content!.x - content!.width)).toBeLessThan(2);
  expect(bubble!.x).toBeGreaterThan(content!.x + 10);
  expect(
    await page
      .locator(".analysis-messages")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
}

test("流式回复逐字递增，用户靠右，完成和刷新后保留 Markdown", async ({ page }) => {
  await mkdir(directory, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const observation = await page.evaluateHandle(() => {
    const values: { text: string; at: number }[] = [];
    const observer = new MutationObserver(() => {
      const text = document
        .querySelector('.assistant-message[data-message-key$=":before"] .markdown-body')
        ?.textContent?.trim();
      if (text && values.at(-1)?.text !== text) values.push({ text, at: performance.now() });
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return { values, disconnect: () => observer.disconnect() };
  });
  await page.getByRole("textbox", { name: "分析问题" }).fill("流式分析本年各科室门诊数据");
  await page.getByRole("button", { name: "发送问题" }).click();
  const first = page.locator('.assistant-message[data-message-key$=":before"] .markdown-body');
  await expect(first).toHaveText("我先核对本年的门诊数据和科室范围。");
  const values = await observation.evaluate((state) => {
    state.disconnect();
    return state.values;
  });
  await observation.dispose();
  const firstChunk = values.filter((value) => "我先核对本年的".startsWith(value.text));
  expect(firstChunk.length).toBeGreaterThanOrEqual(4);
  expect(
    firstChunk.some(
      (value, index) => index > 0 && value.text.length === firstChunk[index - 1]!.text.length + 1,
    ),
  ).toBe(true);
  await userAlignment(page);
  const assistant = await first.boundingBox();
  const user = await page.locator(".user-message .plain-content").boundingBox();
  expect(assistant!.x).toBeLessThan(user!.x);
  await page.screenshot({ path: `${directory}/桌面消息布局.png` });
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible({ timeout: 20000 });
  const answer = page.locator('.assistant-message[data-message-key$=":answer"] .markdown-body');
  await expect(page.locator(".query-results-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(answer.locator(".code-block")).toHaveCount(2);
  await expect(answer.locator(".diagram-output svg")).toHaveCount(1);
  const final = await answer.innerText();
  await page.reload();
  await answer.locator(".diagram-output").scrollIntoViewIfNeeded();
  await expect.poll(() => answer.innerText()).toBe(final);
  await userAlignment(page);
  expect(errors).toEqual([]);
  await writeFile(
    `${directory}/逐字显示时序.json`,
    JSON.stringify({ source: "生产 Web 与真实 HTTP 隔离夹具", values, errors }, null, 2),
  );
});

test("手机长消息靠右并换行，停止输出后正文稳定", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const question = `流式分析本年数据\n${"很长的业务问题".repeat(12)}\n${"abc123".repeat(20)}`;
  await page.getByRole("textbox", { name: "分析问题" }).fill(question);
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.locator(".assistant-message")).toContainText("我先核对本年的");
  await userAlignment(page);
  const bubble = page.locator(".user-message .plain-content");
  await expect(bubble).toHaveText(question);
  expect(await bubble.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "停止分析" }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  const content = await page.locator(".assistant-message").innerText();
  await page.waitForTimeout(1000);
  expect(await page.locator(".assistant-message").innerText()).toBe(content);
  await page.locator(".analysis-messages").evaluate((element) => {
    element.scrollTop = 0;
  });
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/手机消息布局.png` });
});
