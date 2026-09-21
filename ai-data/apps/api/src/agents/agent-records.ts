import { z } from "zod";
import { agentDefinitionSchema, agentVersionSchema, type AgentVersion } from "@ai-data/contracts";
import { parseStoredRecord } from "../metadata/parse-stored-record";

/** SQL 读取边界只接受声明字段，独立列用于核对 JSON 标识与版本。 */
const agentRowSchema = z
  .object({
    agent_id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    definition_json: z.string(),
    skill_fingerprint: z.string(),
    enabled: z.boolean(),
  })
  .strict();
/** 当前启停状态由 Agent 主记录提供，历史定义读取时使用同一状态。 */
const agentStatusSchema = z.object({ enabled: z.boolean() }).strict();

/** 持久化定义损坏或列与 JSON 不一致时按内部数据故障处理。 */
function parseAgentRecord(input: unknown): AgentVersion {
  return parseStoredRecord(() => {
    const row = agentRowSchema.parse(input);
    const definition = agentDefinitionSchema.parse(JSON.parse(row.definition_json) as unknown);
    if (definition.agent_id !== row.agent_id || definition.version !== row.version)
      throw new Error("Agent 定义与索引标识不一致");
    return agentVersionSchema.parse({
      ...definition,
      skill_fingerprint: row.skill_fingerprint,
      enabled: row.enabled,
    });
  });
}

export { agentStatusSchema, parseAgentRecord };
