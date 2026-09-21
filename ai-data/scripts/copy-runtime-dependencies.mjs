import process from "node:process";
import { access, cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** 按 Node 的本地 node_modules 查找顺序定位目录，不依赖包是否公开 CJS 或 package.json。 */
async function resolveInstalledPackage(fromDirectory, name) {
  if (!/^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name))
    throw new Error(`运行依赖包名无效：${name}`);
  let directory = resolve(fromDirectory);
  while (true) {
    if (basename(directory) !== "node_modules") {
      const candidate = join(directory, "node_modules", name);
      try {
        await access(join(candidate, "package.json"));
        return await realpath(candidate);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** npm 的 os/cpu 条件可以同时包含允许项和排除项。 */
function matchesPlatform(values, current) {
  if (!values || !values.length) return true;
  const list = Array.isArray(values) ? values : [values];
  return (
    !list.includes(`!${current}`) &&
    (!list.some((item) => !item.startsWith("!")) || list.includes(current) || list.includes("any"))
  );
}

/** 将已安装依赖按真实解析关系展开为普通目录，祖先已有同一实例时复用以终止循环。 */
async function copyRuntimeDependencies({
  sourceDirectory,
  destinationDirectory,
  entries,
  platform = process.platform,
  arch = process.arch,
}) {
  const destination = resolve(destinationDirectory);
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error("依赖输出目录不能是链接");
  const installed = new Map();
  const records = [];
  // 发布目录内每个已复制节点记录原安装实例，确保 peer 及同名多版本按原关系解析。
  const visible = (parent, name) => {
    let current = parent;
    while (current === destination || current.startsWith(destination + sep)) {
      const candidate = join(current, "node_modules", name);
      if (installed.has(candidate)) return installed.get(candidate);
      current = dirname(current);
    }
    return undefined;
  };
  const visit = async (from, parent, name, optional = false) => {
    const source = await resolveInstalledPackage(from, name);
    if (!source) {
      if (optional) return;
      throw new Error(`缺少必需运行依赖：${name}；请按锁文件准备构建环境`);
    }
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (!matchesPlatform(manifest.os, platform) || !matchesPlatform(manifest.cpu, arch)) {
      if (optional) return;
      throw new Error(`运行依赖 ${name} 不支持 ${platform}-${arch}`);
    }
    if (visible(parent, name) === source) return;
    const target = join(parent, "node_modules", name);
    const prior = installed.get(target);
    if (prior && prior !== source) throw new Error(`运行依赖路径冲突：${name}`);
    if (prior) return;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      dereference: true,
      // 依赖树由下方遍历重建，包自身代码、许可证及原生资源完整复制。
      filter: (path) => path !== join(source, "node_modules"),
    });
    installed.set(target, source);
    records.push({
      install_name: name,
      name: manifest.name,
      version: manifest.version,
      path: relative(destination, target).split(sep).join("/"),
    });
    const dependencies = new Map(
      Object.keys(manifest.dependencies ?? {}).map((key) => [key, false]),
    );
    for (const key of Object.keys(manifest.peerDependencies ?? {}))
      if (!dependencies.has(key))
        dependencies.set(key, manifest.peerDependenciesMeta?.[key]?.optional === true);
    for (const key of Object.keys(manifest.optionalDependencies ?? {})) dependencies.set(key, true);
    for (const [key, isOptional] of [...dependencies].sort(([a], [b]) => a.localeCompare(b)))
      await visit(source, target, key, isOptional);
  };
  for (const name of entries) await visit(await realpath(sourceDirectory), destination, name);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export { copyRuntimeDependencies, resolveInstalledPackage, matchesPlatform };
