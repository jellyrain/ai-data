import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(workspace, "apps/web/package.json"));

/** 从发布目录提供静态站点，验证资源字节、登录页和路由刷新；认证恢复使用未登录响应。 */
async function verifyWebRelease(directory) {
  const { preview } = await import(pathToFileURL(webRequire.resolve("vite")).href);
  const { chromium, expect } = webRequire("@playwright/test");
  const server = await preview({
    configFile: false,
    envDir: false,
    root: dirname(directory),
    publicDir: false,
    build: { outDir: directory },
    preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
  });
  let browser;
  try {
    const address = server.httpServer.address();
    assert(address && typeof address !== "string", "Web 发布验收服务未监听");
    const base = `http://127.0.0.1:${address.port}`;
    const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
      (entry) => entry.isFile(),
    );
    for (const entry of files) {
      const path = join(entry.parentPath, entry.name);
      const url = relative(directory, path).split(sep).map(encodeURIComponent).join("/");
      const response = await globalThis.fetch(`${base}/${url}`);
      assert.equal(response.status, 200, `Web 发布资源读取失败：${url}`);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        await readFile(path),
        `Web 发布资源内容不一致：${url}`,
      );
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) =>
      errors.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    page.on("response", (response) => {
      if (response.status() >= 400 && new URL(response.url()).pathname !== "/auth/refresh")
        errors.push(`${response.status()}: ${response.url()}`);
    });
    await page.route("**/auth/refresh", (route) =>
      route.fulfill({ status: 401, json: { code: "AUTHENTICATION_FAILED", message: "请先登录" } }),
    );
    for (const path of ["/login", "/reports"]) {
      await page.goto(base + path);
      await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "登录工作台", exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
    }
    await page.reload();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    assert.deepEqual(errors, [], "Web 发布页面出现脚本或资源错误");
    return { files: files.length, pageChecks: 3 };
  } finally {
    try {
      await browser?.close();
    } finally {
      server.httpServer.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

export { verifyWebRelease };
