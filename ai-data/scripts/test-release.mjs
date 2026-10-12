import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { join } from "node:path";
import { releaseTarget } from "./prepare-release.mjs";
import { verifyWebRelease } from "./test-web-release.mjs";

// 验收现有三部分发布产物：Web 静态站点与浏览器，再运行 API/DAS 隔离 SQL 验收。
const workspace = fileURLToPath(new URL("../", import.meta.url));
try {
  const target = join(workspace, "release", releaseTarget());
  for (const app of ["api", "das"]) await access(join(target, app, "release-info.json"));
  await access(join(target, "web/index.html"));
  const web = await verifyWebRelease(join(target, "web"));
  process.stdout.write(`Web 发布验收通过：${web.files} 个资源，${web.pageChecks} 项页面检查\n`);
  const child = spawn(
    process.execPath,
    [
      join(workspace, "apps/api/node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.integration.config.ts",
    ],
    {
      cwd: join(workspace, "apps/api"),
      env: { ...process.env, RELEASE_ACCEPTANCE: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  process.stderr.write(
    `发布验收未完成：${error.message}\n请先运行 pnpm build:release，并准备 SQL 测试配置和已安装的 Chromium。\n`,
  );
  process.exitCode = 1;
}
