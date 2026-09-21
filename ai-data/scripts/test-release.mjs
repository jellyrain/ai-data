import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { join } from "node:path";
import { releaseTarget } from "./prepare-release.mjs";

// 专用入口确保先有当前平台产物，再调用现有 Vitest 和隔离 SQL 验收。
const workspace = fileURLToPath(new URL("../", import.meta.url));
try {
  for (const app of ["api", "das"])
    await access(join(workspace, "release", releaseTarget(), app, "release-info.json"));
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
    `发布验收未完成，请先构建当前平台产物并准备 SQL 测试配置：${error.message}\n`,
  );
  process.exitCode = 1;
}
