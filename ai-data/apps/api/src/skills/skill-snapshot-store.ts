import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ApplicationError } from "../errors/application-error";
import { SkillResources, validateSkillNames } from "./skill-resources";
import type { SkillSnapshot, SkillSnapshotStoreOptions } from "./skill-types";

/** 按组织、Agent 和版本发布固定目录，恢复只读取已发布资源。 */
class SkillSnapshotStore {
  private readonly sourceDirectory: string;
  private readonly stateDirectory: string;

  constructor(options: SkillSnapshotStoreOptions) {
    this.sourceDirectory = resolve(options.sourceDirectory);
    this.stateDirectory = resolve(options.stateDirectory);
  }

  async prepare(
    organizationId: string,
    agentId: string,
    version: number,
    names: readonly string[],
  ): Promise<SkillSnapshot> {
    const paths = this.versionPaths(organizationId, agentId, version, names);
    const skills = new SkillResources(this.sourceDirectory, names);
    await this.checkDirectories(paths.slice(0, -1), true);
    const cwd = paths.at(-1)!;
    let published = false;
    try {
      await lstat(cwd);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (published) return this.load(organizationId, agentId, version, names, skills.fingerprint);
    const versionsDirectory = dirname(cwd);
    // 在同级目录写完全部资源后才发布；正式目录始终至少包含 .agents。
    const temporary = await mkdtemp(join(versionsDirectory, `${version}-pending-`));
    if (dirname(resolve(temporary)) !== versionsDirectory)
      throw new ApplicationError("INVALID_INPUT", "Skill 临时发布目录无效");
    try {
      await skills.copyTo(join(temporary, ".agents", "skills"));
      try {
        await rename(temporary, cwd);
      } catch (error) {
        try {
          await lstat(cwd);
        } catch {
          throw error;
        }
        // 同版本已发布或并发发布时，以磁盘中的完整资源核对本次期望。
        return await this.load(organizationId, agentId, version, names, skills.fingerprint);
      }
      return { cwd, skills, fingerprint: skills.fingerprint };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async load(
    organizationId: string,
    agentId: string,
    version: number,
    names: readonly string[],
    fingerprint: string,
  ): Promise<SkillSnapshot> {
    const paths = this.versionPaths(organizationId, agentId, version, names);
    const cwd = paths.at(-1)!;
    const skillsDirectory = join(cwd, ".agents", "skills");
    await this.checkDirectories([...paths, join(cwd, ".agents"), skillsDirectory], false);
    const entries = await readdir(skillsDirectory, { withFileTypes: true });
    if (
      entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) ||
      JSON.stringify(entries.map((entry) => entry.name).sort()) !==
        JSON.stringify([...names].sort())
    )
      throw new ApplicationError("CONFLICT", "Skill 快照与绑定资源不一致");
    const skills = new SkillResources(skillsDirectory, names);
    if (skills.fingerprint !== fingerprint)
      throw new ApplicationError("CONFLICT", "Skill 快照内容与绑定版本不一致");
    return { cwd, skills, fingerprint: skills.fingerprint };
  }

  private versionPaths(
    organizationId: string,
    agentId: string,
    version: number,
    names: readonly string[],
  ): string[] {
    validateSkillNames(names);
    if (!organizationId.trim() || !agentId.trim() || !Number.isSafeInteger(version) || version < 1)
      throw new ApplicationError("INVALID_INPUT", "Skill 快照归属或版本无效");
    const identity = createHash("sha256")
      .update(JSON.stringify([organizationId, agentId]))
      .digest("hex");
    const agents = join(this.stateDirectory, "agents");
    const agent = join(agents, identity);
    const versions = join(agent, "versions");
    return [this.stateDirectory, agents, agent, versions, join(versions, String(version))];
  }

  /** 从配置的状态根目录逐层检查，防止发布和恢复路径穿过目录链接。 */
  private async checkDirectories(paths: string[], create: boolean): Promise<void> {
    for (const path of paths) {
      try {
        if (create) await mkdir(path, { recursive: true });
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new ApplicationError("INVALID_INPUT", "Skill 快照路径必须是普通目录");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new ApplicationError("NOT_FOUND", "已发布的 Skill 快照不存在", { cause: error });
        throw error;
      }
    }
  }
}

export { SkillSnapshotStore };
