import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
const evidence = fileURLToPath(new URL("../../../../../任务交接/前端第3步验收/", import.meta.url));
async function login(page: Page, username = "admin") {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
}

test("窄屏登录的键盘操作、校验与主题文字对比度", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.getByText("请输入用户名", { exact: true })).toBeVisible();
  const appearance = page.getByRole("button", { name: "外观设置" });
  await appearance.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "亮色", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveClass("dark");
  await page.keyboard.press("Escape");
  await expect(appearance).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const mode of ["亮色", "暗色"])
    for (const palette of ["橄榄绿", "海蓝", "青绿", "紫罗兰"]) {
      await appearance.click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: palette, exact: true }).click();
      await appearance.click();
      for (const hover of [false, true]) {
        if (hover) await page.getByRole("button", { name: "登录工作台" }).hover();
        else await page.locator("h1").hover();
        const ratio = await page.locator(".login-submit").evaluate((element) => {
          const style = getComputedStyle(element);
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const ctx = canvas.getContext("2d")!;
          const luminance = (color: string) => {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data)
              .slice(0, 3)
              .map((value) => {
                const normalized = value / 255;
                return normalized <= 0.04045
                  ? normalized / 12.92
                  : ((normalized + 0.055) / 1.055) ** 2.4;
              });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
          };
          const fg = luminance(style.color),
            bg = luminance(style.backgroundColor);
          return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        });
        expect(
          ratio,
          `${mode}/${palette}/${hover ? "悬停" : "普通"}文字对比度`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  await page.screenshot({ path: `${evidence}/login-mobile-dark.png`, fullPage: true });
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("Web-test-2026!");
  await page.getByLabel("密码", { exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
});
test("真实认证 Cookie、错误提示、深层恢复、代理和退出", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/reports/report-03/edit");
  await expect(page).toHaveURL(/\/login/);
  await page.screenshot({ path: `${evidence}/login-light-olive.png`, fullPage: true });
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.getByRole("alert")).toContainText("账号或密码错误");
  await login(page);
  await expect(page).toHaveURL(/\/reports\/report-03\/edit$/);
  const cookie = (await context.cookies()).find((value) => value.name === "refresh_token");
  expect(cookie).toMatchObject({ httpOnly: true, path: "/auth", sameSite: "Lax" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("refresh_token");
  await page.reload();
  await expect(page.getByLabel("报表标题", { exact: true })).toHaveValue("待运行的门诊报表");
  expect((await context.cookies()).find((value) => value.name === "refresh_token")?.value).not.toBe(
    cookie?.value,
  );
  expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain("accessToken");
  const health = await page.request.get("/api/health");
  expect(await health.json()).toEqual({ status: "ok" });
  const missing = await page.request.get("/api/missing");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await context.cookies()).find((value) => value.name === "refresh_token")).toBeUndefined();
  expect(errors).toEqual([]);
});
test("普通身份菜单、直达权限、窄屏导航及账号切换", async ({ page }) => {
  await page.goto("/login");
  await login(page, "analyst");
  await expect(page.getByRole("link", { name: "模型管理" })).toHaveCount(0);
  await page.goto("/settings/models");
  await expect(page.getByRole("heading", { name: "暂无访问权限" })).toBeVisible();
  await page.getByRole("button", { name: "返回工作台" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "报表中心" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/workspace-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("link", { name: "模型管理" })).toBeVisible();
  await page.screenshot({ path: `${evidence}/workspace-1024.png`, fullPage: true });
});
test("多标签页恢复、身份切换与退出同步", async ({ page, context }) => {
  await page.goto("/login");
  await login(page);
  const second = await context.newPage();
  await second.goto("/reports");
  await expect(second.getByRole("button", { name: "退出登录" })).toBeVisible();
  await Promise.all([page.reload(), second.reload()]);
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  await expect(second.getByRole("button", { name: "退出登录" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(second).toHaveURL(/\/login/);
  await login(page, "analyst");
  await expect(second.getByRole("button", { name: "退出登录" })).toBeVisible();
  await expect(second.getByRole("link", { name: "模型管理" })).toHaveCount(0);
});
test("四套配色的明暗模式、弹层、持久化及系统变化", async ({ page, context }) => {
  await page.goto("/login");
  await login(page);
  for (const mode of ["亮色", "暗色"]) {
    for (const [palette, id] of [
      ["橄榄绿", "olive"],
      ["海蓝", "blue"],
      ["青绿", "teal"],
      ["紫罗兰", "violet"],
    ]) {
      await page.getByRole("button", { name: "外观设置" }).click();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.getByRole("button", { name: palette, exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-palette", id);
      await expect(page.locator("html")).toHaveAttribute(
        "data-mode",
        mode === "暗色" ? "dark" : "light",
      );
      await page.screenshot({
        path: `${evidence}/theme-${mode === "暗色" ? "dark" : "light"}-${id}.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "外观设置" }).click();
    }
  }
  await page.reload();
  await expect(page.locator("html")).toHaveClass("dark");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "violet");
  const second = await context.newPage();
  await second.goto("/reports");
  await page.getByRole("button", { name: "外观设置" }).click();
  await page.getByRole("button", { name: "跟随系统" }).click();
  await expect(second.locator("html")).toHaveAttribute("data-mode", "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass("dark");
});
test("服务断网与退出失败提供重试", async ({ page }) => {
  await page.route("**/auth/refresh", (route) => route.abort());
  await page.goto("/analysis");
  await expect(page.getByRole("heading", { name: "暂时无法连接服务" })).toBeVisible();
  await page.unroute("**/auth/refresh");
  await page.getByRole("button", { name: "重试" }).click();
  await login(page);
  await page.route("**/auth/logout", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "DATA_SOURCE_UNAVAILABLE",
        message: "暂时不可用",
        request_id: "test-request",
      }),
    }),
  );
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "退出尚未完成" })).toBeVisible();
  await page.unroute("**/auth/logout");
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page).toHaveURL(/\/login/);
});
