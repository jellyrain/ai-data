import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillCatalog } from "../../src/skills/skill-catalog";
import { SkillSnapshotStore } from "../../src/skills/skill-snapshot-store";

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
  const directory = await mkdtemp(join(testRoot, "ai-data-snapshot-test-"));
  directories.push(directory);
  const sourceDirectory = join(directory, "source");
  const stateDirectory = join(directory, "state");
  for (const name of ["analysis", "query"]) {
    await mkdir(join(sourceDirectory, name, "references"), { recursive: true });
    await writeFile(
      join(sourceDirectory, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} 方法\n---\n入口`,
    );
    await writeFile(join(sourceDirectory, name, "references", "guide.md"), `${name} 子文档`);
    await writeFile(join(sourceDirectory, name, "sample.bin"), Buffer.from([0, 255, 23]));
  }
  return {
    directory,
    sourceDirectory,
    stateDirectory,
    catalog: new SkillCatalog(sourceDirectory),
    store: new SkillSnapshotStore({ sourceDirectory, stateDirectory }),
  };
}

// BDD：公共库提供可选 Skill 及完整资源摘要；资源读取只允许选中目录内的 Markdown。
describe("Skill 公共目录", () => {
  it("读取名称、描述和稳定摘要，子资源更新后目录摘要变化", async () => {
    const h = await setup();
    const before = h.catalog.list();
    expect(before).toEqual([
      { name: "analysis", description: "analysis 方法", fingerprint: expect.any(String) },
      { name: "query", description: "query 方法", fingerprint: expect.any(String) },
    ]);
    expect(h.catalog.list()).toEqual(before);
    expect(h.catalog.read("query").relative_path).toBe("SKILL.md");
    expect(h.catalog.read("query", "references/guide.md").content).toBe("query 子文档");
    await writeFile(join(h.sourceDirectory, "query", "sample.bin"), Buffer.from([1]));
    expect(h.catalog.list()[1]?.fingerprint).not.toBe(before[1]?.fingerprint);
  });

  it("真实业务 Skill 的元数据可用于目录", () => {
    const entries = new SkillCatalog(resolve("../../packages/skills")).list();
    expect(entries.map((entry) => entry.name)).toEqual(["query-analysis", "query-dsl"]);
    expect(entries.every((entry) => entry.description.length > 0)).toBe(true);
  });

  it.each(["missing", "../query", "query/../analysis"])("拒绝未知或非法名称 %s", async (name) => {
    const h = await setup();
    expect(() => h.catalog.read(name)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("拒绝目录名与入口声明不符，以及缺少描述的入口", async () => {
    const h = await setup();
    await writeFile(
      join(h.sourceDirectory, "query", "SKILL.md"),
      "---\nname: other\ndescription: 方法\n---",
    );
    expect(() => h.catalog.list()).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    await writeFile(join(h.sourceDirectory, "query", "SKILL.md"), "---\nname: query\n---");
    expect(() => h.catalog.list()).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("Markdown 读取拒绝穿越与其他类型文件", async () => {
    const h = await setup();
    for (const path of [
      "../analysis/SKILL.md",
      "C:/secret.md",
      "references\\guide.md",
      "sample.bin",
    ]) {
      expect(() => h.catalog.read("query", path)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
    }
  });

  it("支持单行引号文本，拒绝重复字段及 YAML 复合标记", async () => {
    const h = await setup();
    const entry = join(h.sourceDirectory, "query", "SKILL.md");
    await writeFile(entry, `---\nname: "query"\ndescription: '读者''指南'\n---`);
    expect(h.catalog.list()[1]?.description).toBe("读者'指南");
    for (const metadata of [
      "name: query\nname: query\ndescription: 方法",
      "name: query\ndescription: *description",
      "name: query\ndescription: >\n  方法",
    ]) {
      await writeFile(entry, `---\n${metadata}\n---`);
      expect(() => h.catalog.list()).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});

// BDD：每个组织、Agent 和配置版本固定完整资源；同版本并发发布应复用同一已发布目录。
describe("Agent 版本 Skill 快照", () => {
  it("完整发布绑定资源，同版本复用，其他 Agent、组织及版本分别持有目录", async () => {
    const h = await setup();
    const first = await h.store.prepare("org-1", "agent-1", 1, ["query"]);
    expect(first.skills.names).toEqual(["query"]);
    const published = join(first.cwd, ".agents", "skills");
    expect(await readdir(published)).toEqual(["query"]);
    expect(await readFile(join(published, "query", "sample.bin"))).toEqual(
      Buffer.from([0, 255, 23]),
    );
    const same = await h.store.prepare("org-1", "agent-1", 1, ["query"]);
    expect(same.cwd).toBe(first.cwd);
    expect(same.fingerprint).toBe(first.fingerprint);
    const otherAgent = await h.store.prepare("org-1", "agent-2", 1, ["query"]);
    const otherOrg = await h.store.prepare("org-2", "agent-1", 1, ["query"]);
    const otherVersion = await h.store.prepare("org-1", "agent-1", 2, ["query"]);
    expect(new Set([first.cwd, otherAgent.cwd, otherOrg.cwd, otherVersion.cwd]).size).toBe(4);
  });

  it("公共库更新后旧版仍读原内容，新版使用更新内容，覆盖旧版被拒绝", async () => {
    const h = await setup();
    const first = await h.store.prepare("org", "agent", 1, ["query"]);
    await writeFile(join(h.sourceDirectory, "query", "references", "guide.md"), "新方法");
    const loaded = await h.store.load("org", "agent", 1, ["query"], first.fingerprint);
    expect(loaded.skills.readReference("query", "references/guide.md").content).toBe(
      "query 子文档",
    );
    await expect(h.store.prepare("org", "agent", 1, ["query"])).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const next = await h.store.prepare("org", "agent", 2, ["query"]);
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(next.skills.readReference("query", "references/guide.md").content).toBe("新方法");
  });

  it("多个存储实例并发发布同一版本时复用完整目录", async () => {
    const h = await setup();
    const otherStore = new SkillSnapshotStore(h);
    const snapshots = await Promise.all([
      h.store.prepare("org", "agent", 1, ["query", "analysis"]),
      otherStore.prepare("org", "agent", 1, ["analysis", "query"]),
    ]);
    expect(snapshots[0]?.cwd).toBe(snapshots[1]?.cwd);
    expect(snapshots[0]?.fingerprint).toBe(snapshots[1]?.fingerprint);
    expect(await readdir(dirname(snapshots[0]!.cwd))).toEqual(["1"]);
  });

  it("不同内容并发发布同一版本时一个成功，另一个冲突且保留已发布内容", async () => {
    const h = await setup();
    const other = await setup();
    await writeFile(join(other.sourceDirectory, "query", "references", "guide.md"), "另一来源");
    const otherStore = new SkillSnapshotStore({
      sourceDirectory: other.sourceDirectory,
      stateDirectory: h.stateDirectory,
    });
    const results = await Promise.allSettled([
      h.store.prepare("org", "agent", 1, ["query"]),
      otherStore.prepare("org", "agent", 1, ["query"]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "CONFLICT" });
    const snapshot = results.find((result) => result.status === "fulfilled")!.value;
    const loaded = await h.store.load("org", "agent", 1, ["query"], snapshot.fingerprint);
    expect(loaded.fingerprint).toBe(snapshot.fingerprint);
    expect(await readdir(dirname(snapshot.cwd))).toEqual(["1"]);
  });

  it("快照目录缺失时恢复报错，保留源库也不重建", async () => {
    const h = await setup();
    await expect(h.store.load("org", "agent", 1, ["query"], "a".repeat(64))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(readdir(h.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("恢复检查期望 Skill 列表、完整摘要与额外资源", async () => {
    const h = await setup();
    const first = await h.store.prepare("org", "agent", 1, ["query"]);
    await expect(
      h.store.load("org", "agent", 1, ["analysis"], first.fingerprint),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(h.store.load("org", "agent", 1, ["query"], "0".repeat(64))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await writeFile(join(first.cwd, ".agents", "skills", "query", "sample.bin"), Buffer.from([9]));
    await expect(
      h.store.load("org", "agent", 1, ["query"], first.fingerprint),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await mkdir(join(first.cwd, ".agents", "skills", "extra"));
    await expect(
      h.store.load("org", "agent", 1, ["query"], first.fingerprint),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("空 Skill 列表可发布及恢复", async () => {
    const h = await setup();
    const snapshot = await h.store.prepare("org", "agent", 1, []);
    expect(await readdir(join(snapshot.cwd, ".agents", "skills"))).toEqual([]);
    const loaded = await h.store.load("org", "agent", 1, [], snapshot.fingerprint);
    expect(loaded.skills.names).toEqual([]);
  });

  it("已发布版本资源丢失时再次准备也拒绝重建", async () => {
    const h = await setup();
    const snapshot = await h.store.prepare("org", "agent", 1, ["query"]);
    const agents = join(snapshot.cwd, ".agents");
    expect(dirname(agents)).toBe(snapshot.cwd);
    await rm(agents, { recursive: true, force: true });
    await expect(h.store.prepare("org", "agent", 1, ["query"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await readdir(snapshot.cwd)).toEqual([]);
  });

  it("未知名称、重复名称或缺失入口均拒绝发布", async () => {
    const h = await setup();
    for (const names of [["missing"], ["../query"], ["query", "query"]]) {
      await expect(h.store.prepare("org", "agent", 1, names)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    await rm(join(h.sourceDirectory, "query", "SKILL.md"));
    await expect(h.store.prepare("org", "agent", 1, ["query"])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("非法版本及缺失归属拒绝形成目录", async () => {
    const h = await setup();
    for (const version of [0, -1, 1.5, NaN]) {
      await expect(h.store.prepare("org", "agent", version, [])).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    await expect(h.store.prepare("", "agent", 1, [])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("源资源链接与已发布父目录链接均拒绝", async () => {
    const h = await setup();
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(
      join(h.sourceDirectory, "analysis"),
      join(h.sourceDirectory, "query", "linked"),
      linkType,
    );
    await expect(h.store.prepare("org", "agent", 1, ["query"])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await rm(join(h.sourceDirectory, "query", "linked"));
    const snapshot = await h.store.prepare("org", "agent", 1, ["query"]);
    const agents = join(snapshot.cwd, ".agents");
    await rm(agents, { recursive: true, force: true });
    await symlink(h.sourceDirectory, agents, linkType);
    await expect(
      h.store.load("org", "agent", 1, ["query"], snapshot.fingerprint),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
