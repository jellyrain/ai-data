import { resolve } from "node:path";
import type { MetadataTransactionalExecutor } from "@ai-data/metadata";
import { LocalMasterKeyStore } from "@ai-data/metadata/secrets";
import type { ApiConfig } from "../config/api-config";
import { ApplicationError } from "../errors/application-error";
import { ModelService } from "../models/model-service";
import { SqlModelRepository } from "../models/sql-model-repository";
import { ModelCredentialCipher } from "../models/model-credential-cipher";
import { SkillCatalog } from "../skills/skill-catalog";
import { SkillSnapshotStore } from "../skills/skill-snapshot-store";
import { AgentRuntime } from "../runtime/agent-runtime";
import { toolInputs } from "../runtime/tool-contracts";
import { AgentService } from "./agent-service";
import { SqlAgentRepository } from "./sql-agent-repository";

/** 服务端统一装配组织配置、私有凭据库和固定 Skill 资源。 */
function createAgentConfiguration(dependencies: {
  database: MetadataTransactionalExecutor;
  config?: ApiConfig["analysis_runtime"];
  startupDirectory: string;
  skillsDirectory: string;
}) {
  const { database, config } = dependencies;
  const stateDirectory = resolve(
    dependencies.startupDirectory,
    config?.state_directory ?? "secrets/codex-runtime",
  );
  const skills = new SkillCatalog(dependencies.skillsDirectory);
  const snapshots = new SkillSnapshotStore({
    sourceDirectory: dependencies.skillsDirectory,
    stateDirectory,
  });
  const models = new ModelService({
    repository: new SqlModelRepository(database),
    credentials: new ModelCredentialCipher(
      new LocalMasterKeyStore(resolve(stateDirectory, "model-keys")),
    ),
  });
  const agents = new AgentService({
    repository: new SqlAgentRepository(database),
    resolveModel: async (context, id, version) => {
      await models.resolve(context, id, version);
    },
    prepareSkills: async (org, id, version, names) => {
      const available = new Set(names.length ? skills.list().map((skill) => skill.name) : []);
      if (names.some((name) => !available.has(name)))
        throw new ApplicationError("INVALID_INPUT", "Agent 选择了不存在的 Skill");
      return snapshots.prepare(org, id, version, names);
    },
    listToolNames: () => Object.keys(toolInputs),
  });
  const runtime = new AgentRuntime({ database, agents, models, snapshots });

  return { agents, models, skills, runtime };
}

export { createAgentConfiguration };
