import process from "node:process";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { copyRuntimeDependencies } from "../copy-runtime-dependencies.mjs";

/** 每个用例只清理自己创建的临时目录。 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ai-data-package-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const source = join(root, "source"),
    destination = join(root, "release");
  await mkdir(source);
  await mkdir(destination);
  return { root, source, destination };
}
async function pkg(parent, installedName, manifest, content = "module.exports = 'ok';") {
  const directory = join(parent, "node_modules", installedName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: installedName, version: "1.0.0", main: "index.js", ...manifest }),
  );
  await writeFile(join(directory, "index.js"), content);
  await writeFile(join(directory, "LICENSE"), "test license");
  return directory;
}
test("复制 ESM-only 入口与 npm 别名时保留安装名称，产物移动后可解析", async (t) => {
  const f = await fixture(t);
  await pkg(
    f.source,
    "sdk",
    {
      type: "module",
      exports: { ".": { import: "./index.js" } },
      dependencies: { runtime: "npm:actual@1.0.0" },
    },
    "export const ready = true;",
  );
  await pkg(f.source, "runtime", { name: "actual" });
  const records = await copyRuntimeDependencies({
    sourceDirectory: f.source,
    destinationDirectory: f.destination,
    entries: ["sdk"],
  });
  assert.equal(records.find((r) => r.install_name === "runtime").name, "actual");
  const sdk = join(f.destination, "node_modules/sdk");
  const require = createRequire(join(sdk, "package.json"));
  assert.ok(require.resolve("runtime").startsWith(f.destination));
  assert.equal(await readFile(join(sdk, "LICENSE"), "utf8"), "test license");
  assert.equal((await lstat(sdk)).isSymbolicLink(), false);
});
test("同名多版本、必要 peer 及循环依赖按各自安装关系保留", async (t) => {
  const f = await fixture(t);
  const a = await pkg(f.source, "a", {
    dependencies: { b: "1", shared: "1" },
    peerDependencies: { peer: "1" },
  });
  const b = await pkg(f.source, "b", { dependencies: { a: "1", shared: "2" } });
  await pkg(a, "shared", { version: "1.0.0" });
  await pkg(b, "shared", { version: "2.0.0" });
  await pkg(f.source, "peer", {});
  await copyRuntimeDependencies({
    sourceDirectory: f.source,
    destinationDirectory: f.destination,
    entries: ["a"],
  });
  const requireA = createRequire(join(f.destination, "node_modules/a/package.json"));
  const requireB = createRequire(requireA.resolve("b/package.json"));
  assert.equal(requireA("shared/package.json").version, "1.0.0");
  assert.equal(requireB("shared/package.json").version, "2.0.0");
  assert.equal(
    requireB.resolve("a/package.json"),
    join(f.destination, "node_modules/a/package.json"),
  );
  assert.ok(requireA.resolve("peer").startsWith(f.destination));
});
test("pnpm 目录链接转换为真实文件，复制后不依赖源目录", async (t) => {
  const f = await fixture(t);
  const store = await pkg(f.root, "stored", { name: "actual" });
  await mkdir(join(f.source, "node_modules"));
  await symlink(
    store,
    join(f.source, "node_modules/alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await copyRuntimeDependencies({
    sourceDirectory: f.source,
    destinationDirectory: f.destination,
    entries: ["alias"],
  });
  assert.equal((await lstat(join(f.destination, "node_modules/alias"))).isSymbolicLink(), false);
  const require = createRequire(join(f.destination, "package.json"));
  assert.equal(require("alias"), "ok");
});
for (const platform of ["win32", "linux", "darwin"])
  for (const arch of ["x64", "arm64"]) {
    test(`${platform}-${arch} 只复制匹配的可选平台资源，保留可执行文件模式`, async (t) => {
      const f = await fixture(t);
      await pkg(f.source, "runtime", {
        optionalDependencies: { target: "1", other: "1", absent: "1" },
        peerDependencies: { optionalPeer: "1" },
        peerDependenciesMeta: { optionalPeer: { optional: true } },
      });
      const target = await pkg(f.source, "target", { os: [platform], cpu: [arch] });
      await pkg(f.source, "other", { os: ["!" + platform] });
      await chmod(join(target, "index.js"), 0o755);
      const records = await copyRuntimeDependencies({
        sourceDirectory: f.source,
        destinationDirectory: f.destination,
        entries: ["runtime"],
        platform,
        arch,
      });
      assert.deepEqual(records.map((r) => r.install_name).sort(), ["runtime", "target"]);
      if (process.platform !== "win32")
        assert.equal(
          (
            await stat(
              join(
                f.destination,
                records.find((r) => r.install_name === "target").path,
                "index.js",
              ),
            )
          ).mode & 0o777,
          0o755,
        );
    });
  }
test("缺失必要运行或 peer 依赖时拒绝，并拒绝越界包名", async (t) => {
  const f = await fixture(t);
  await pkg(f.source, "broken", { peerDependencies: { required: "1" } });
  await assert.rejects(
    copyRuntimeDependencies({
      sourceDirectory: f.source,
      destinationDirectory: f.destination,
      entries: ["broken"],
    }),
    /required/,
  );
  await assert.rejects(
    copyRuntimeDependencies({
      sourceDirectory: f.source,
      destinationDirectory: f.destination,
      entries: ["missing"],
    }),
    /missing/,
  );
  await assert.rejects(
    copyRuntimeDependencies({
      sourceDirectory: f.source,
      destinationDirectory: f.destination,
      entries: ["../outside"],
    }),
    /包名/,
  );
});
