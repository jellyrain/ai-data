import process from "node:process";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  symlink,
  readdir,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { prepareRelease, releaseTarget, replaceReleaseDirectory } from "../prepare-release.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ai-data-release-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const put = async (file, content) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  };
  await put("package.json", JSON.stringify({ engines: { node: ">=24.19.0 <25" } }));
  await put("scripts/runtime-dependencies.json", JSON.stringify({ api: [], das: [] }));
  for (const [app, name] of [
    ["api", "api"],
    ["data-access", "das"],
  ]) {
    await put(`apps/${app}/package.json`, JSON.stringify({ name: app, version: "1.0.0" }));
    await put(`apps/${app}/dist/index.js`, "console.log('ready');");
    await put(`apps/${app}/migrations/000.sql`, "SELECT 1;");
    await put(
      `apps/${app}/config/${name}.release.config.example.json`,
      JSON.stringify({ example: true }),
    );
    await put(`apps/${app}/config/${name}.config.json`, "private configuration");
    await put(`apps/${app}/secrets/private`, "private key");
  }
  await put("packages/skills/query-dsl/SKILL.md", "entry");
  await put("packages/skills/query-dsl/references/query.md", "reference");
  await put("apps/web/package.json", JSON.stringify({ name: "web", version: "1.0.0" }));
  await put("apps/web/dist/index.html", '<script type="module" src="/assets/app.js"></script>');
  await put("apps/web/dist/assets/app.js", "console.log('web');");
  await put("apps/web/dist/assets/export-worker.js", "postMessage('export');");
  await put("apps/web/dist/fonts/noto/font.otf", "font fixture");
  await put("apps/web/dist/fonts/noto/OFL.txt", "font license");
  await put("apps/web/.env.local", "private build configuration");
  return { root, put };
}
test("按平台生成三个独立目录，携带后端运行资源和 Web 静态资源，单项整理保留其余应用", async (t) => {
  const f = await fixture(t);
  await prepareRelease({ workspaceDirectory: f.root });
  const target = join(f.root, "release", releaseTarget());
  assert.equal(
    await readFile(join(target, "api/skills/query-dsl/references/query.md"), "utf8"),
    "reference",
  );
  assert.equal(JSON.parse(await readFile(join(target, "api/package.json"), "utf8")).type, "module");
  assert.equal(
    JSON.parse(await readFile(join(target, "das/release-info.json"), "utf8")).platform,
    process.platform,
  );
  await assert.rejects(access(join(target, "api/secrets/private")));
  await assert.rejects(access(join(target, "das/config/das.config.json")));
  assert.equal(await readFile(join(target, "web/assets/app.js"), "utf8"), "console.log('web');");
  assert.equal(await readFile(join(target, "web/fonts/noto/OFL.txt"), "utf8"), "font license");
  await assert.rejects(access(join(target, "web/.env.local")));
  await writeFile(join(target, "das/unchanged"), "marker");
  await writeFile(join(target, "web/unchanged"), "web marker");
  await prepareRelease({ workspaceDirectory: f.root, applications: ["api"] });
  assert.equal(await readFile(join(target, "das/unchanged"), "utf8"), "marker");
  assert.equal(await readFile(join(target, "web/unchanged"), "utf8"), "web marker");
});
test("Web 重复封包完整复制 dist 并清除旧资源，保留原始构建与其他应用", async (t) => {
  const f = await fixture(t);
  await prepareRelease({ workspaceDirectory: f.root });
  const target = join(f.root, "release", releaseTarget());
  await f.put(`release/${releaseTarget()}/api/unchanged`, "api marker");
  await f.put(`release/${releaseTarget()}/web/assets/old.js`, "stale asset");
  await f.put("apps/web/dist/assets/new.js", "new asset");
  await prepareRelease({ workspaceDirectory: f.root, applications: ["web"] });
  const source = join(f.root, "apps/web/dist");
  const files = await readdir(source, { recursive: true, withFileTypes: true });
  for (const entry of files.filter((entry) => entry.isFile())) {
    const relative = join(entry.parentPath, entry.name).slice(source.length + 1);
    assert.deepEqual(
      await readFile(join(target, "web", relative)),
      await readFile(join(source, relative)),
    );
  }
  await assert.rejects(access(join(target, "web/assets/old.js")));
  assert.equal(await readFile(join(target, "api/unchanged"), "utf8"), "api marker");
  await access(join(target, "das/dist/index.js"));
});
test("缺少 Web 入口时拒绝封包并保留已发布文件", async (t) => {
  const f = await fixture(t);
  await prepareRelease({ workspaceDirectory: f.root, applications: ["web"] });
  await rm(join(f.root, "apps/web/dist/index.html"));
  await assert.rejects(
    prepareRelease({ workspaceDirectory: f.root, applications: ["web"] }),
    /index.html/,
  );
  await access(join(f.root, "release", releaseTarget(), "web/index.html"));
});
test("新产物重命名失败时恢复旧发布目录，成功替换后清理旧目录", async (t) => {
  const f = await fixture(t);
  await f.put("release/staged/index.html", "new release");
  await f.put("release/web/index.html", "old release");
  const temporary = join(f.root, "release/staged");
  const destination = join(f.root, "release/web");
  const failPublish = async (source, target) => {
    if (source === temporary) throw Object.assign(new Error("模拟目录占用"), { code: "EPERM" });
    return rename(source, target);
  };
  await assert.rejects(
    replaceReleaseDirectory(f.root, temporary, destination, failPublish),
    /目录占用/,
  );
  assert.equal(await readFile(join(destination, "index.html"), "utf8"), "old release");
  await replaceReleaseDirectory(f.root, temporary, destination);
  assert.equal(await readFile(join(destination, "index.html"), "utf8"), "new release");
  assert.deepEqual(await readdir(join(f.root, "release")), ["web"]);
});
test("缺失依赖时保留原发布目录，拒绝未知应用或架构", async (t) => {
  const f = await fixture(t);
  await prepareRelease({ workspaceDirectory: f.root, applications: ["das"] });
  await f.put("scripts/runtime-dependencies.json", JSON.stringify({ api: [], das: ["missing"] }));
  await assert.rejects(
    prepareRelease({ workspaceDirectory: f.root, applications: ["das"] }),
    /missing/,
  );
  await access(join(f.root, "release", releaseTarget(), "das/dist/index.js"));
  await assert.rejects(
    prepareRelease({ workspaceDirectory: f.root, applications: ["../outside"] }),
    /应用/,
  );
  assert.throws(() => releaseTarget("linux", "ia32"), /平台/);
});
test("拒绝通过发布目录链接写到外部，也保留已放入产物目录的实例状态", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "outside"));
  await symlink(
    join(f.root, "outside"),
    join(f.root, "release"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(prepareRelease({ workspaceDirectory: f.root }), /链接/);
  await rm(join(f.root, "release"));
  await prepareRelease({ workspaceDirectory: f.root, applications: ["api"] });
  await f.put(`release/${releaseTarget()}/api/secrets/keep`, "state");
  await assert.rejects(
    prepareRelease({ workspaceDirectory: f.root, applications: ["api"] }),
    /实例/,
  );
  assert.equal(
    await readFile(join(f.root, "release", releaseTarget(), "api/secrets/keep"), "utf8"),
    "state",
  );
});
test("API 缺少当前平台原生程序时拒绝交付，补齐后可解析 npm 别名布局", async (t) => {
  const f = await fixture(t);
  await f.put(
    "scripts/runtime-dependencies.json",
    JSON.stringify({ api: ["@openai/codex-sdk"], das: [] }),
  );
  const base = "apps/api/node_modules/";
  await f.put(
    base + "@openai/codex-sdk/package.json",
    JSON.stringify({
      name: "@openai/codex-sdk",
      version: "1.0.0",
      dependencies: { "@openai/codex": "1.0.0" },
    }),
  );
  await f.put(
    base + "@openai/codex/package.json",
    JSON.stringify({
      name: "@openai/codex",
      version: "1.0.0",
      optionalDependencies: { "@openai/codex-linux-arm64": "npm:@openai/codex@1.0.0-linux-arm64" },
    }),
  );
  const options = {
    workspaceDirectory: f.root,
    applications: ["api"],
    platform: "linux",
    arch: "arm64",
  };
  await assert.rejects(prepareRelease(options), /缺少 Codex linux-arm64/);
  await assert.rejects(access(join(f.root, "release/linux-arm64/api")));
  await f.put(
    base + "@openai/codex-linux-arm64/package.json",
    JSON.stringify({
      name: "@openai/codex",
      version: "1.0.0-linux-arm64",
      os: ["linux"],
      cpu: ["arm64"],
    }),
  );
  await f.put(
    base + "@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex",
    "native fixture",
  );
  await prepareRelease(options);
  const info = JSON.parse(
    await readFile(join(f.root, "release/linux-arm64/api/release-info.json"), "utf8"),
  );
  assert(
    info.dependencies.some(
      (d) => d.install_name === "@openai/codex-linux-arm64" && d.name === "@openai/codex",
    ),
  );
});
for (const platform of ["win32", "linux", "darwin"])
  for (const arch of ["x64", "arm64"]) {
    test(`目标标识 ${platform}-${arch}`, () =>
      assert.equal(releaseTarget(platform, arch), `${platform}-${arch}`));
  }
