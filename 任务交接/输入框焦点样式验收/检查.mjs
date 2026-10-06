import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import setup from "../../ai-data/apps/web/tests/support/e2e-servers.ts";

const output = fileURLToPath(new URL("./", import.meta.url));
const requireWeb = createRequire(
  new URL("../../ai-data/apps/web/package.json", import.meta.url),
);
const { chromium } = requireWeb("@playwright/test");
const stop = await setup();
let browser;
const checks = [];
const errors = [];

// 使用正式 Web 页面及现有隔离认证服务，检查焦点的实际计算样式并留存截图。
async function inspect(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      focused: document.activeElement === element,
    };
  });
}

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (mode) =>
        localStorage.setItem(
          "ai-data.appearance.v1",
          JSON.stringify({ mode, palette: "olive" }),
        ),
      mode,
    );
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:5317/login");
    const username = page.getByLabel("用户名", { exact: true });
    const password = page.getByLabel("密码", { exact: true });
    await username.click();
    const clicked = await inspect(username);
    assert(clicked.focused && clicked.outline === "none");
    await username.press("Tab");
    const tabbed = await inspect(password);
    assert(tabbed.focused && tabbed.outline === "none");
    await page.getByRole("button", { name: "登录工作台" }).click();
    const error = page.getByText("请输入用户名", { exact: true });
    await error.waitFor({ state: "visible" });
    await username.click();
    const invalid = await username.evaluate((element) => {
      const item = element.closest(".el-form-item");
      return {
        error: item.classList.contains("is-error"),
        outline: getComputedStyle(element).outlineStyle,
        shadow: getComputedStyle(item.querySelector(".el-input__wrapper"))
          .boxShadow,
      };
    });
    assert(
      invalid.error && invalid.outline === "none" && invalid.shadow !== "none",
    );
    await page.locator(".login-form-panel").screenshot({
      path: `${output}/${mode}-登录输入框.png`,
      animations: "disabled",
    });
    await username.fill("editor");
    await password.fill("Web-test-2026!");
    await page.getByRole("button", { name: "登录工作台" }).click();
    await page.waitForURL(/analysis/);
    const textarea = page.getByLabel("分析问题", { exact: true });
    await textarea.click();
    const multiline = await inspect(textarea);
    assert(multiline.focused && multiline.outline === "none");
    await page.locator(".question-form").screenshot({
      path: `${output}/${mode}-多行输入框.png`,
      animations: "disabled",
    });
    const appearance = page.getByRole("button", { name: "外观设置" });
    await appearance.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const button = await inspect(appearance);
    assert(
      button.focused &&
        button.outline === "solid" &&
        parseFloat(button.outlineWidth) > 0,
      JSON.stringify(button),
    );
    checks.push({ mode, clicked, tabbed, invalid, multiline, button });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/结果.json`,
    JSON.stringify({ passed: true, checks, browser_errors: errors }, null, 2) +
      "\n",
  );
  process.stdout.write(
    "亮暗主题下的点击、Tab、校验提示、多行输入及按钮焦点检查通过。\n",
  );
} finally {
  await browser?.close();
  await stop();
}
