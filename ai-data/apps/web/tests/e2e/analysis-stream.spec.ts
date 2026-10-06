import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(
  new URL("../../../../../任务交接/页面03-05流式验收/", import.meta.url),
);
test.use({
  viewport: { width: 1920, height: 1080 },
  video: { mode: "on", size: { width: 1920, height: 1080 } },
});
test("真实 HTTP 持续交付文字、工具与后续说明，刷新恢复完整顺序", async ({ page }) => {
  await mkdir(directory, { recursive: true });
  const stages: { stage: string; elapsed_ms: number; text?: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("textbox", { name: "分析问题" }).fill("流式分析本年各科室门诊数据");
  const started = Date.now();
  const shot = async (stage: string) => {
    stages.push({ stage, elapsed_ms: Date.now() - started });
    await page.screenshot({ path: `${directory}/${stage}.png`, fullPage: false });
  };
  await page.getByRole("button", { name: "发送问题" }).click();
  const first = page.locator('.assistant-message[data-message-key$=":before"]');
  await expect(first).toContainText("我先核对本年的");
  await expect(page.getByText("分析完成", { exact: true })).toHaveCount(0);
  await shot("03-文字生成中");
  await expect(first).toContainText("门诊数据和科室范围。");
  const tool = page.locator('.tool-record[data-tool-key$=":catalog"]');
  await expect(tool).toContainText("执行中");
  await shot("04-工具执行中");
  await expect(tool).toContainText("已完成");
  await expect(page.locator('.assistant-message[data-message-key$=":after"]')).toContainText(
    "本年各科室的门诊记录。",
  );
  await shot("05-工具后的说明");
  const answer = page.locator('.assistant-message[data-message-key$=":answer"]');
  await expect(answer).toContainText("门诊分析结论");
  const early = await answer.innerText();
  stages.push({ stage: "最终正文首次到达", elapsed_ms: Date.now() - started, text: early });
  await expect
    .poll(async () => (await answer.innerText()).length)
    .toBeGreaterThan(early.length + 30);
  await expect(page.getByText("分析完成", { exact: true })).toHaveCount(0);
  await shot("06-最终正文持续输出");
  // 用户向上阅读时，后续文字不得把滚动位置拉回底部。
  await page.locator(".analysis-messages").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "查看最新回复" })).toBeVisible();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  expect(
    await page.locator(".analysis-messages").evaluate((element) => element.scrollTop),
  ).toBeLessThan(5);
  const process = page.getByRole("button", { name: /查看分析过程/ });
  await expect(process).toHaveAttribute("aria-expanded", "false");
  await expect(first).toBeHidden();
  await expect(tool).toBeHidden();
  await expect(page.locator(".progress-summary:visible")).toHaveCount(0);
  await expect(answer).toBeVisible();
  await expect(page.getByRole("region", { name: "查询结果", exact: true }).first()).toBeVisible();
  await expect(page.locator(".diagram-output svg")).toHaveCount(1);
  await shot("07-最终完成");
  await process.click();
  const collapse = page.getByRole("button", { name: /收起分析过程/ });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(first).toBeVisible();
  await expect(tool).toBeVisible();
  await shot("08-展开分析过程");
  const order = await page
    .locator(".run-timeline > .assistant-message, .run-timeline > .tool-record")
    .evaluateAll((elements) =>
      elements.map(
        (element) =>
          element.getAttribute("data-message-key") ?? element.getAttribute("data-tool-key"),
      ),
    );
  expect(order).toEqual([
    "1:message:before",
    "1:tool:catalog",
    "1:message:after",
    "1:tool:query-1",
    "1:message:result",
    "1:message:answer",
  ]);
  await collapse.click();
  await expect(first).toBeHidden();
  await expect(answer).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "门诊分析结论" })).toHaveCount(1);
  await expect(process).toHaveAttribute("aria-expanded", "false");
  await expect(first).toBeHidden();
  await process.click();
  await expect(first).toBeVisible();
  await expect(first).toContainText("门诊数据和科室范围。");
  await expect(page.locator(".tool-record")).toHaveCount(2);
  expect(errors).toEqual([]);
  await writeFile(
    `${directory}/浏览器流式时序.json`,
    JSON.stringify(
      {
        viewport: "1920×1080",
        source: "真实 HTTP 路由与生产 Web，数据为隔离验收夹具",
        stages,
        order,
        errors,
      },
      null,
      2,
    ),
  );
});

test("生成中取消保留已有片段，迟到文字停止，账号切换清除时间线", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("textbox", { name: "分析问题" }).fill("流式分析");
  await page.getByRole("button", { name: "发送问题" }).click();
  await expect(page.locator(".assistant-message")).toContainText("我先核对本年的");
  await page.getByRole("button", { name: "停止分析" }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await expect(page.locator(".assistant-message")).toContainText("输出已停止");
  await expect(page.locator(".assistant-message")).toBeVisible();
  await expect(page.getByRole("button", { name: /查看分析过程/ })).toHaveCount(0);
  const content = await page.locator(".assistant-message").innerText();
  await page.waitForTimeout(1500);
  expect(await page.locator(".assistant-message").innerText()).toBe(content);
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.locator(".assistant-message")).toHaveCount(0);
});
