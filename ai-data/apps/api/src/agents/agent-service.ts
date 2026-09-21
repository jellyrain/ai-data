import { agentDefinitionSchema, type AgentVersion } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type { AgentServiceDependencies } from "./agent-types";

/** 组织管理员或被授予 Agent 管理权限的用户可发布和启停配置。 */
function assertAgentManagement(context: AuthContext): void {
  if (!context.roles.includes("system_admin") && !context.permissions.includes("agents:manage"))
    throw new ApplicationError("UNAUTHORIZED", "无 Agent 管理权限");
}

/** 校验发布资源并保存固定版本；组织范围来自已认证上下文。 */
class AgentService {
  constructor(private readonly dependencies: AgentServiceDependencies) {}

  async publish(context: AuthContext, input: unknown): Promise<AgentVersion> {
    assertAgentManagement(context);
    const definition = agentDefinitionSchema.parse(input);
    const tools = new Set(this.dependencies.listToolNames());
    if (definition.tool_names.some((name) => !tools.has(name)))
      throw new ApplicationError("INVALID_INPUT", "Agent 包含未注册的工具");
    // 在复制资源前拒绝已知版本冲突；仓储事务仍负责竞争请求的最终版本检查。
    const previous = await this.dependencies.repository.find(
      context.organizationId,
      definition.agent_id,
    );
    if (definition.version !== (previous?.version ?? 0) + 1)
      throw new ApplicationError("CONFLICT", "Agent 版本必须顺序递增，已发布版本不可改写");
    await this.dependencies.resolveModel(context, definition.model_id, definition.model_version);
    const skills = await this.dependencies.prepareSkills(
      context.organizationId,
      definition.agent_id,
      definition.version,
      definition.skill_names,
    );
    return this.dependencies.repository.publish(
      context.organizationId,
      definition,
      skills.fingerprint,
    );
  }

  async get(context: AuthContext, agentId: string, version?: number): Promise<AgentVersion> {
    const agent = await this.dependencies.repository.find(context.organizationId, agentId, version);
    if (!agent) throw new ApplicationError("NOT_FOUND", "Agent 不存在");
    return agent;
  }

  async list(context: AuthContext): Promise<AgentVersion[]> {
    return this.dependencies.repository.list(context.organizationId);
  }

  async setEnabled(context: AuthContext, agentId: string, isEnabled: boolean): Promise<void> {
    assertAgentManagement(context);
    if (
      !(await this.dependencies.repository.setEnabled(context.organizationId, agentId, isEnabled))
    )
      throw new ApplicationError("NOT_FOUND", "Agent 不存在");
  }
}

export { AgentService };
