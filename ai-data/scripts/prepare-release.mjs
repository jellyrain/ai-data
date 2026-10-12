import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { copyRuntimeDependencies, resolveInstalledPackage } from "./copy-runtime-dependencies.mjs";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const applications = { api: "api", das: "data-access", web: "web" };

/** 产包目标跟随当前构建环境，平台资源需在对应环境准备。 */
function releaseTarget(platform = process.platform, arch = process.arch) {
  if (!["win32", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw new Error(`不支持的发布平台：${platform}-${arch}`);
  return `${platform}-${arch}`;
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
/** 对每一级目录拒绝链接，递归清理前再次验证物理路径仍位于预期产物目录。 */
async function verifyDirectory(root, path) {
  const absolute = resolve(path);
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error("发布目录超出工作区");
  if (absolute !== root) await verifyDirectory(root, dirname(absolute));
  if (await exists(absolute)) {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("发布目录不能经过链接");
    if (!info.isDirectory()) throw new Error("发布路径不是目录");
    if ((await realpath(absolute)) !== absolute) throw new Error("发布目录物理路径不匹配");
  }
}
/** 复制成功之后检查当前官方解析规则所需的原生文件，缺失平台包不能形成可交付目录。 */
async function verifyCodex(directory, platform, arch) {
  const sdk = await resolveInstalledPackage(directory, "@openai/codex-sdk");
  const codex = sdk && (await resolveInstalledPackage(sdk, "@openai/codex"));
  const platformPackage =
    codex && (await resolveInstalledPackage(codex, `@openai/codex-${platform}-${arch}`));
  const cpu = arch === "x64" ? "x86_64" : "aarch64";
  const suffix = { win32: "pc-windows-msvc", linux: "unknown-linux-musl", darwin: "apple-darwin" }[
    platform
  ];
  const vendor = platformPackage ?? codex;
  if (
    !vendor ||
    !(await exists(
      join(
        vendor,
        "vendor",
        `${cpu}-${suffix}`,
        "bin",
        platform === "win32" ? "codex.exe" : "codex",
      ),
    ))
  )
    throw new Error(`缺少 Codex ${platform}-${arch} 原生程序，请在目标平台按锁文件准备依赖`);
}

/** Windows 目录句柄可能在删除或扫描后短暂占用，沿用发布清理的有限重试预算。 */
async function renameDirectory(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 10
      )
        throw error;
      await setTimeout(100);
    }
  }
}

/** 替换期间保留旧目录，新目录发布失败时恢复；回退失败则留下旧目录供恢复。 */
async function replaceReleaseDirectory(root, temporary, destination, move = renameDirectory) {
  await verifyDirectory(root, temporary);
  await verifyDirectory(root, destination);
  assert.equal(dirname(temporary), dirname(destination), "发布临时目录必须与目标同级");
  const previous = `${temporary}-previous`;
  await verifyDirectory(root, previous);
  const hasPrevious = await exists(destination);
  if (hasPrevious) await move(destination, previous);
  try {
    await move(temporary, destination);
  } catch (error) {
    if (hasPrevious) {
      try {
        await move(previous, destination);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `发布替换及回退失败，旧目录保存在 ${previous}`,
          { cause: restoreError },
        );
      }
    }
    throw error;
  }
  if (hasPrevious) {
    await verifyDirectory(root, previous);
    await rm(previous, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** 在专用 staging 目录完成全部复制和检查后，替换当前服务生成产物。 */
async function prepareRelease(options = {}) {
  const root = await realpath(resolve(options.workspaceDirectory ?? workspace));
  const selected = options.applications ?? ["api", "das", "web"];
  if (!selected.length || selected.some((name) => !Object.hasOwn(applications, name)))
    throw new Error("发布应用仅支持 api、das 或 web");
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const target = releaseTarget(platform, arch);
  const parent = join(root, "release", target);
  await verifyDirectory(root, parent);
  await mkdir(parent, { recursive: true });
  const config = await readJson(join(root, "scripts/runtime-dependencies.json"));
  const workspaceManifest = await readJson(join(root, "package.json"));
  const outputs = [];
  for (const app of selected) {
    const source = join(root, "apps", applications[app]);
    const destination = join(parent, app);
    await verifyDirectory(root, destination);
    if (
      (await exists(join(destination, "secrets"))) ||
      (await exists(join(destination, "config", `${app}.config.json`)))
    )
      throw new Error(`发布目录 ${app} 已包含实例配置或状态，请使用独立部署目录并保留实例数据`);
    await access(join(source, "dist", app === "web" ? "index.html" : "index.js"));
    const temporary = await mkdtemp(join(parent, `${app}-pending-`));
    try {
      if (app === "web") {
        // 完整保留 Vite 的资源路径，发布目录可直接作为静态站点根目录。
        await cp(join(source, "dist"), temporary, { recursive: true, dereference: true });
      } else {
        const manifest = await readJson(join(source, "package.json"));
        await mkdir(join(temporary, "dist"));
        await mkdir(join(temporary, "config"));
        await cp(join(source, "dist/index.js"), join(temporary, "dist/index.js"));
        await cp(join(source, "migrations"), join(temporary, "migrations"), {
          recursive: true,
          dereference: true,
        });
        await cp(
          join(source, "config", `${app}.release.config.example.json`),
          join(temporary, "config", `${app}.config.example.json`),
        );
        if (app === "api")
          await cp(join(root, "packages/skills"), join(temporary, "skills"), {
            recursive: true,
            dereference: true,
          });
        const dependencies = await copyRuntimeDependencies({
          sourceDirectory: source,
          destinationDirectory: temporary,
          entries: config[app],
          platform,
          arch,
        });
        if (config[app].includes("@openai/codex-sdk")) await verifyCodex(temporary, platform, arch);
        const direct = Object.fromEntries(
          config[app].map((name) => {
            const dependency = dependencies.find((d) => d.path === `node_modules/${name}`);
            return [
              name,
              dependency.name === name
                ? dependency.version
                : `npm:${dependency.name}@${dependency.version}`,
            ];
          }),
        );
        const files = {
          "package.json": {
            name: manifest.name,
            version: manifest.version,
            private: true,
            type: "module",
            engines: workspaceManifest.engines,
            scripts: { start: "node dist/index.js" },
            dependencies: direct,
          },
          "release-info.json": {
            service: app,
            version: manifest.version,
            platform,
            arch,
            engines: workspaceManifest.engines,
            dependencies,
          },
        };
        for (const [name, value] of Object.entries(files))
          await writeFile(join(temporary, name), JSON.stringify(value, null, 2) + "\n");
      }
      await replaceReleaseDirectory(root, temporary, destination);
      outputs.push(destination);
    } finally {
      await verifyDirectory(root, temporary);
      assert.equal(dirname(temporary), parent, "临时发布目录范围无效");
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selected = process.argv.slice(2);
    for (const path of await prepareRelease({
      ...(selected.length ? { applications: selected } : {}),
    }))
      process.stdout.write(`发布目录：${path}\n`);
  } catch (error) {
    process.stderr.write(`发布整理失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

export { prepareRelease, releaseTarget, replaceReleaseDirectory };
