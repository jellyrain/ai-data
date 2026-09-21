import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlServerMetadataDatabase } from "@ai-data/metadata/sqlserver";
import { apiConfigSchema } from "../../src/config/api-config";
import { createAgentConfiguration } from "../../src/agents/create-agent-configuration";
import { CodexAnalysisHarness } from "../../src/harness/codex-analysis-harness";
import type { AuthContext } from "../../src/auth/auth-types";

/** 显式启用的真实模型验收从已有数据库读取组织 Agent、模型和凭据，仅复制到隔离验收库使用。 */
async function readConfiguredDialogueRuntime() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const config = apiConfigSchema.parse(
    JSON.parse(readFileSync(resolve(root, "config/api.config.json"), "utf8")),
  );
  const runtime = config.analysis_runtime;
  if (!runtime?.enabled) throw new Error("本地模型验收需要启用 analysis_runtime");
  const organizationId =
    process.env.LOCAL_MODEL_ORGANIZATION_ID ?? config.bootstrap_admin?.organization_id;
  if (!organizationId)
    throw new Error("本地模型验收需要 LOCAL_MODEL_ORGANIZATION_ID 或初始化组织标识");
  const context: AuthContext = {
    organizationId,
    userId: "model-acceptance",
    sessionId: "model-acceptance",
    roles: [],
    permissions: [],
    dataPolicies: [],
  };
  const database = await SqlServerMetadataDatabase.connect(config.metadata_sqlserver);
  try {
    const services = createAgentConfiguration({
      database,
      config: runtime,
      startupDirectory: root,
      skillsDirectory: resolve(root, runtime.skills_directory ?? "../../packages/skills"),
    });
    const agent = await services.agents.get(context, process.env.LOCAL_MODEL_AGENT_ID ?? "default");
    if (!agent.enabled) throw new Error("本地模型验收指定的 Agent 已停用");
    const provider = await services.models.resolve(context, agent.model_id, agent.model_version);
    const hostname = new URL(provider.baseUrl).hostname;
    const octets = hostname.split(".").map(Number);
    const privateIpv4 =
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
    if (!privateIpv4 && hostname !== "localhost" && hostname !== "[::1]")
      throw new Error("本地模型验收需要数据库模型使用回环地址或私有 IPv4 地址");
    return { runtime, agent, provider };
  } finally {
    await database.close();
  }
}

/** 官方实例的模型、资源和预算由每次请求绑定的 Agent 提供。 */
function configuredDialogueHarness(stateDirectory: string): CodexAnalysisHarness {
  return new CodexAnalysisHarness({ stateDirectory });
}

export { configuredDialogueHarness, readConfiguredDialogueRuntime };
