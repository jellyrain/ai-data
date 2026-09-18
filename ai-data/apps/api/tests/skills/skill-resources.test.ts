import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillResources } from "../../src/skills/skill-resources";

const testRoot = resolve("secrets");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== testRoot) throw new Error("测试目录超出项目范围");
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "ai-data-skills-test-"));
  directories.push(directory);
  const source = join(directory, "source");
  for (const name of ["query-analysis", "query-dsl", "unloaded"]) {
    await mkdir(join(source, name, "references"), { recursive: true });
    await writeFile(
      join(source, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: 测试\n---\n入口`,
    );
  }
  const reference = join(source, "query-dsl", "references", "query.md");
  await writeFile(reference, "已加载的查询说明");
  await writeFile(join(source, "query-dsl", "sample.json"), '{"private":true}');
  return { directory, source, reference };
}

describe("Skill 目录资源与按需读取", () => {
  it("完整复制目录并保持启动快照，清除上一版本残留文件", async () => {
    const h = await setup();
    const skills = new SkillResources(h.source);
    await writeFile(h.reference, "稍后修改的说明");
    const target = join(h.directory, "published");
    await mkdir(join(target, "query-dsl"), { recursive: true });
    await writeFile(join(target, "query-dsl", "old.md"), "旧文件");
    await skills.copyTo(target);
    expect(await readFile(join(target, "query-dsl", "references", "query.md"), "utf8")).toBe(
      "已加载的查询说明",
    );
    expect(await readFile(join(target, "query-dsl", "sample.json"), "utf8")).toBe(
      '{"private":true}',
    );
    await expect(readFile(join(target, "query-dsl", "old.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(skills.readReference("query-dsl", "references/query.md")).toEqual({
      skill_name: "query-dsl",
      relative_path: "references/query.md",
      content: "已加载的查询说明",
    });
  });
  it("相同资源摘要稳定，子文档修改及删除都会改变摘要", async () => {
    const h = await setup();
    const original = new SkillResources(h.source).fingerprint;
    expect(new SkillResources(h.source).fingerprint).toBe(original);
    await writeFile(h.reference, "新版说明");
    const changed = new SkillResources(h.source).fingerprint;
    expect(changed).not.toBe(original);
    await rm(h.reference);
    expect(new SkillResources(h.source).fingerprint).not.toBe(changed);
  });
  it.each([
    ["unloaded", "SKILL.md"],
    ["query-dsl", "../query-analysis/SKILL.md"],
    ["query-dsl", "references/../../outside.md"],
    ["query-dsl", "C:/outside.md"],
    ["query-dsl", "references\\query.md"],
    ["query-dsl", "sample.json"],
    ["query-dsl", "references/missing.md"],
  ])("拒绝未加载 Skill、目录外路径及非 Markdown：%s %s", async (name, path) => {
    const h = await setup();
    const skills = new SkillResources(h.source);
    expect(() => skills.readReference(name, path)).toThrow();
  });
  it("拒绝通过目录链接把 Skill 外文件纳入可读取资源", async () => {
    const h = await setup();
    const outside = join(h.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "目录外内容");
    await symlink(
      outside,
      join(h.source, "query-dsl", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => new SkillResources(h.source)).toThrow("Skill 资源不支持符号链接");
  });
});
