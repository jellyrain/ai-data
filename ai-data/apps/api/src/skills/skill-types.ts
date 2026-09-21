import type { SkillResources } from "./skill-resources";

/** Agent 配置版本的固定运行目录及完整 Skill 资源。 */
type SkillSnapshot = {
  cwd: string;
  skills: SkillResources;
  fingerprint: string;
};

/** 公共源库与持久运行目录由服务部署配置提供。 */
type SkillSnapshotStoreOptions = {
  sourceDirectory: string;
  stateDirectory: string;
};

export type { SkillSnapshot, SkillSnapshotStoreOptions };
