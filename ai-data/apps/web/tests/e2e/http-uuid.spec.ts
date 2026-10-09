import { expect, test } from "@playwright/test";

test.use({
  baseURL: "http://ai-data-http.test:5317",
  video: "off",
});

function localUrl(url: string): string {
  return url.replace("http://ai-data-http.test:5317", "http://127.0.0.1:5317");
}

test("普通 HTTP 来源发送对话，丢失回执后复用请求键并渲染流程图", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // 保留页面的普通 HTTP 来源，仅将网络目的地改写到本机隔离服务。
  await page.route("http://ai-data-http.test:5317/**", (route) =>
    route.continue({ url: localUrl(route.request().url()) }),
  );
  await page.goto("/login");
  expect(new URL(page.url()).hostname).toBe("ai-data-http.test");
  expect(
    await page.evaluate(() => ({
      secure: window.isSecureContext,
      uuid: typeof crypto.randomUUID,
      random: typeof crypto.getRandomValues,
    })),
  ).toEqual({ secure: false, uuid: "undefined", random: "function" });
  await page.getByLabel("用户名", { exact: true }).fill("analyst");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分析工作台", exact: true })).toBeVisible();

  const keys: string[] = [];
  const runIds: string[] = [];
  await page.route("**/api/conversations/*/messages", async (route) => {
    keys.push(route.request().postDataJSON().idempotency_key);
    const response = await route.fetch({ url: localUrl(route.request().url()) });
    expect(response.ok()).toBe(true);
    runIds.push((await response.json()).analysisRun.id);
    // 服务端已接受第一次提交，但客户端未收到回执。
    if (keys.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.getByRole("textbox", { name: "分析问题" }).fill("HTTP 兼容验收：查询今年门诊人次");
  await page.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试发送", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "重试发送", exact: true }).click();
  await expect(page.getByText("分析完成", { exact: true })).toBeVisible();
  await expect(page.locator(".diagram-output svg")).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(keys[1]).toBe(keys[0]);
  expect(runIds[1]).toBe(runIds[0]);
  expect(errors).toEqual([]);
});
