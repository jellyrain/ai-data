import { lstatSync, readdirSync } from "node:fs";
import type { SkillCatalogEntry } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";
import { SkillResources } from "./skill-resources";

/** 管理接口读取公共源库；元信息和摘要基于本次调用时的完整资源。 */
class SkillCatalog {
  constructor(private readonly sourceDirectory: string) {}

  list(): SkillCatalogEntry[] {
    const stat = lstatSync(this.sourceDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new ApplicationError("INVALID_INPUT", "Skill 源目录必须是普通目录");
    return readdirSync(this.sourceDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .filter((entry) => {
        if (entry.isSymbolicLink())
          throw new ApplicationError("INVALID_INPUT", "Skill 资源不支持符号链接");
        return entry.isDirectory();
      })
      .map(({ name }) => {
        const resources = new SkillResources(this.sourceDirectory, [name]);
        const metadata = readMetadata(resources.readReference(name, "SKILL.md").content);
        if (metadata.name !== name)
          throw new ApplicationError("INVALID_INPUT", "Skill 目录名称与入口声明不一致");
        return { name, description: metadata.description, fingerprint: resources.fingerprint };
      });
  }

  read(name: string, relativePath = "SKILL.md") {
    return new SkillResources(this.sourceDirectory, [name]).readReference(name, relativePath);
  }
}

/** 只解析入口所需的单行 name/description 文本，不执行 YAML 标签或别名。 */
function readMetadata(content: string): { name: string; description: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!frontmatter) throw new ApplicationError("INVALID_INPUT", "Skill 入口缺少元信息");
  const values = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^(name|description):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if (values.has(key) || !value || /^[>|&*!{[]/.test(value))
      throw new ApplicationError("INVALID_INPUT", "Skill 元信息须使用单行文本");
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch (cause) {
        throw new ApplicationError("INVALID_INPUT", "Skill 元信息引号无效", { cause });
      }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value))
        throw new ApplicationError("INVALID_INPUT", "Skill 元信息引号无效");
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    if (!value.trim()) throw new ApplicationError("INVALID_INPUT", "Skill 元信息不能为空");
    values.set(key, value);
  }
  const name = values.get("name");
  const description = values.get("description");
  if (!name || !description)
    throw new ApplicationError("INVALID_INPUT", "Skill 入口需要名称和描述");
  return { name, description };
}

export { SkillCatalog };
