import type { AgentDefinition, AgentVersion } from "@ai-data/contracts";
import type { AuthContext } from "../../src/auth/auth-types";

/** Agent 管理测试使用的组织管理员与完整发布配置。 */
const agentAdmin: AuthContext = {
  userId: "agent-admin",
  organizationId: "hospital-a",
  sessionId: "session-a",
  roles: ["system_admin"],
  permissions: [],
  dataPolicies: [],
};
const agentDefinition: AgentDefinition = {
  agent_id: "outpatient",
  version: 1,
  name: "门诊分析",
  description: "就诊统计",
  instructions: "依据授权数据回答",
  model_id: "analysis-model",
  model_version: 1,
  tool_names: ["query_data", "read_skill_reference"],
  skill_names: ["query-analysis"],
  limits: { timeout_ms: 60000, max_tool_calls: 10, max_context_bytes: 64000 },
};
const skillFingerprint = "a".repeat(64);
const agentVersion: AgentVersion = {
  ...agentDefinition,
  skill_fingerprint: skillFingerprint,
  enabled: true,
};

export { agentAdmin, agentDefinition, agentVersion, skillFingerprint };
