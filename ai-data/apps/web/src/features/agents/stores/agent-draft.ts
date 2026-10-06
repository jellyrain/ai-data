import { agentDefinitionSchema, type AgentDefinition, type AgentVersion } from "@ai-data/contracts";
/** 默认限制沿用现有运行边界，按需工具定义在已注册时由页面加入。 */
function emptyAgent(): AgentDefinition {
  return {
    agent_id: "",
    version: 1,
    name: "",
    description: "",
    instructions: "",
    model_id: "",
    model_version: 1,
    tool_names: [],
    skill_names: [],
    limits: { timeout_ms: 600000, max_tool_calls: 30, max_context_bytes: 65536 },
  };
}
function agentDraft(value: AgentVersion, version: number): AgentDefinition {
  const { enabled: _enabled, skill_fingerprint: _fingerprint, ...definition } = value;
  void _enabled;
  void _fingerprint;
  return agentDefinitionSchema.parse({ ...definition, version });
}
export { emptyAgent, agentDraft };
