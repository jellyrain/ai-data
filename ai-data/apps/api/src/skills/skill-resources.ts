import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ApplicationError } from "../errors/application-error";

/** 启动时固定已加载 Skill 的完整资源，供目录复制、按需读取和线程版本判断共用。 */
class SkillResources {
  private readonly files = new Map<string, Map<string, Buffer>>();
  readonly fingerprint: string;

  constructor(directory: string, names: readonly string[] = ["query-analysis", "query-dsl"]) {
    const hash = createHash("sha256");
    for (const name of [...names].sort()) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || this.files.has(name))
        throw new ApplicationError("INVALID_INPUT", "Skill 名称无效或重复");
      const root = resolve(directory, name);
      const files = new Map<string, Buffer>();
      const collect = (path: string, relativePath: string) => {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
          throw new ApplicationError("INVALID_INPUT", "Skill 资源不支持符号链接");
        if (stat.isDirectory()) {
          for (const child of readdirSync(path).sort())
            collect(join(path, child), relativePath ? `${relativePath}/${child}` : child);
        } else if (stat.isFile()) {
          const content = readFileSync(path);
          files.set(relativePath, content);
          hash.update(JSON.stringify([name, relativePath, content.length])).update(content);
        } else throw new ApplicationError("INVALID_INPUT", "Skill 资源仅支持普通文件和目录");
      };
      collect(root, "");
      if (!files.has("SKILL.md")) throw new ApplicationError("INVALID_INPUT", "Skill 缺少入口文件");
      this.files.set(name, files);
    }
    this.fingerprint = hash.digest("hex");
  }

  get names(): readonly string[] {
    return [...this.files.keys()];
  }

  /** 只在已加载的资源快照中查找 Markdown，模型提供的路径不会用于访问文件系统。 */
  readReference(skillName: string, relativePath: string) {
    if (
      relativePath.includes("\\") ||
      relativePath.includes(":") ||
      relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
      !relativePath.endsWith(".md")
    )
      throw new ApplicationError("INVALID_INPUT", "Skill 引用必须是目录内的 Markdown 相对路径");
    const content = this.files.get(skillName)?.get(relativePath);
    if (!content) throw new ApplicationError("NOT_FOUND", "Skill 文档不存在或未加载");
    return {
      skill_name: skillName,
      relative_path: relativePath,
      content: content.toString("utf8"),
    };
  }

  /** 发布同一份完整资源快照；只替换目标目录内明确命名的已加载 Skill 子目录。 */
  async copyTo(directory: string): Promise<void> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    for (const [name, files] of this.files) {
      const target = resolve(root, name);
      if (dirname(target) !== root)
        throw new ApplicationError("INVALID_INPUT", "Skill 发布目录无效");
      await rm(target, { recursive: true, force: true });
      for (const [relativePath, content] of files) {
        const file = join(target, ...relativePath.split("/"));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
      }
    }
  }
}

export { SkillResources };
