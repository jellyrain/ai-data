import process from "node:process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { prepareRelease, releaseTarget } from "../prepare-release.mjs";

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
  return { root, put };
}
test("按平台生成两个独立目录，完整携带示例迁移和 Skill，重复整理不影响另一服务", async (t) => {
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
  await writeFile(join(target, "das/unchanged"), "marker");
  await prepareRelease({ workspaceDirectory: f.root, applications: ["api"] });
  assert.equal(await readFile(join(target, "das/unchanged"), "utf8"), "marker");
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
